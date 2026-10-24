//! Process loopback (ADR 0001 §4.1): `ActivateAudioInterfaceAsync` с
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` — звук дерева процессов приложения (показ окна)
//! или всей системы, кроме дерева Cord (показ экрана). Формат — float32, 48 кГц, стерео, порции по
//! 10 мс; когда приложение молчит, поток подкладывает тишину по часам (`pcm::Pacer`).
//!
//! Документированный минимум — build 20348, на деле работает с Windows 10 2004 (так делает OBS);
//! не удалось активировать — `error` с причиной, и показ идёт без звука.
//!
//! Поток захвата — в MMCSS «Pro Audio» (R01–R03): под нагрузкой игры планировщик будит его вовремя,
//! и порции идут ровно, а не пачками с тишиной от `Pacer` между ними.
use std::collections::HashMap;
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use napi::bindgen_prelude::Float32Array;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Error, Result, Status};
use windows::core::{implement, w, Interface, Ref};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, IAgileObject, IAgileObject_Impl, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

use crate::pcm::{Chunker, Pacer, CHANNELS, CHUNK_SAMPLES, SAMPLE_RATE};
use crate::{AudioCallback, AudioEvent};

const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const ACTIVATE_TIMEOUT_MS: u32 = 5_000;
const IDLE_SILENCE_MS: u64 = 30;

struct Session {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);

fn sessions() -> std::sync::MutexGuard<'static, HashMap<u32, Session>> {
    SESSIONS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn start_audio(pid: u32, include: bool, callback: AudioCallback) -> Result<u32> {
    if include && pid == 0 {
        return Err(Error::new(Status::InvalidArg, "нет PID приложения"));
    }
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = std::thread::Builder::new()
        .name(format!("cord-native-audio-{id}"))
        .spawn(move || {
            let outcome = capture_thread(pid, include, &callback, &flag);
            let event = match outcome {
                Ok(()) => AudioEvent { state: "ended".into(), pcm: None, reason: None },
                Err(reason) => AudioEvent { state: "error".into(), pcm: None, reason: Some(reason) },
            };
            callback.call(event, ThreadsafeFunctionCallMode::NonBlocking);
        })
        .map_err(|error| Error::new(Status::GenericFailure, format!("поток захвата: {error}")))?;
    sessions().insert(id, Session { stop, thread: Some(thread) });
    Ok(id)
}

pub fn stop_audio(session: u32) -> Result<()> {
    let removed = sessions().remove(&session);
    if let Some(mut item) = removed {
        item.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = item.thread.take() {
            let _ = thread.join();
        }
    }
    Ok(())
}

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct ActivationDone {
    event: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationDone_Impl {
    fn ActivateCompleted(&self, _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        // SAFETY: событие создано в capture_thread и живёт дольше активации.
        unsafe { SetEvent(self.event) }
    }
}

impl IAgileObject_Impl for ActivationDone_Impl {}

struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        // SAFETY: парный вызов к CoInitializeEx в этом же потоке.
        unsafe { CoUninitialize() };
    }
}

/// Поток в MMCSS «Pro Audio» на время захвата; служба MMCSS выключена — работаем без неё.
struct Mmcss(HANDLE);

impl Mmcss {
    fn join() -> Option<Self> {
        let mut task = 0u32;
        // SAFETY: имя задачи — статическая строка, индекс — локальная переменная.
        unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task) }.ok().map(Self)
    }
}

impl Drop for Mmcss {
    fn drop(&mut self) {
        // SAFETY: парный вызов к AvSetMmThreadCharacteristicsW в этом же потоке.
        let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
    }
}

fn describe(what: &str, error: windows::core::Error) -> String {
    format!("{what}: {error}")
}

fn activate(pid: u32, include: bool) -> std::result::Result<IAudioClient, String> {
    // SAFETY: структуры живут до конца функции; PROPVARIANT с VT_BLOB указывает на них, как в
    // образце Microsoft (ApplicationLoopback).
    unsafe {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: if include { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE },
                },
            },
        };
        let blob = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 },
                    },
                }),
            },
        };
        let done = CreateEventW(None, false, false, None).map_err(|error| describe("CreateEvent", error))?;
        let handler: IActivateAudioInterfaceCompletionHandler = ActivationDone { event: done }.into();
        let operation = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&blob), &handler).map_err(|error| describe("ActivateAudioInterfaceAsync", error));
        let operation = match operation {
            Ok(operation) => operation,
            Err(message) => {
                let _ = CloseHandle(done);
                return Err(message);
            }
        };
        let waited = WaitForSingleObject(done, ACTIVATE_TIMEOUT_MS);
        let _ = CloseHandle(done);
        if waited != WAIT_OBJECT_0 {
            return Err("активация process loopback не завершилась за 5 с".into());
        }
        let mut hresult = windows::core::HRESULT(0);
        let mut unknown = None;
        operation.GetActivateResult(&mut hresult, &mut unknown).map_err(|error| describe("GetActivateResult", error))?;
        hresult.ok().map_err(|error| describe("process loopback", error))?;
        let unknown = unknown.ok_or_else(|| "активация не вернула IAudioClient".to_string())?;
        unknown.cast::<IAudioClient>().map_err(|error| describe("IAudioClient", error))
    }
}

fn capture_thread(pid: u32, include: bool, callback: &AudioCallback, stop: &AtomicBool) -> std::result::Result<(), String> {
    // SAFETY: COM поднимается в этом потоке и опускается ComGuard при выходе.
    let _com = unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|error| describe("CoInitializeEx", error))?;
        ComGuard
    };
    let _mmcss = Mmcss::join();
    let client = activate(pid, include)?;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * (CHANNELS as u32) * 4,
        nBlockAlign: (CHANNELS * 4) as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    // SAFETY: обычная последовательность WASAPI; дескриптор события закрывается в конце.
    unsafe {
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0, &format, None)
            .map_err(|error| describe("IAudioClient::Initialize", error))?;
        let event = CreateEventW(None, false, false, None).map_err(|error| describe("CreateEvent", error))?;
        let result = (|| -> std::result::Result<(), String> {
            client.SetEventHandle(event).map_err(|error| describe("SetEventHandle", error))?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|error| describe("IAudioCaptureClient", error))?;
            client.Start().map_err(|error| describe("IAudioClient::Start", error))?;
            let started = Instant::now();
            let now_ms = || started.elapsed().as_millis() as u64;
            let mut chunker = Chunker::new();
            let mut pacer = Pacer::new(now_ms(), IDLE_SILENCE_MS);
            let outcome = loop {
                if stop.load(Ordering::Relaxed) {
                    break Ok(());
                }
                let _ = WaitForSingleObject(event, 10);
                loop {
                    let packet = match capture.GetNextPacketSize() {
                        Ok(size) => size,
                        Err(error) => return Err(describe("GetNextPacketSize", error)),
                    };
                    if packet == 0 {
                        break;
                    }
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).map_err(|error| describe("GetBuffer", error))?;
                    if frames > 0 {
                        if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                            chunker.push_silence(frames as usize);
                        } else {
                            chunker.push(std::slice::from_raw_parts(data as *const f32, frames as usize * CHANNELS));
                        }
                        pacer.on_packet(now_ms());
                    }
                    capture.ReleaseBuffer(frames).map_err(|error| describe("ReleaseBuffer", error))?;
                }
                for chunk in chunker.drain() {
                    callback.call(AudioEvent { state: "pcm".into(), pcm: Some(Float32Array::new(chunk)), reason: None }, ThreadsafeFunctionCallMode::NonBlocking);
                }
                for _ in 0..pacer.tick(now_ms()) {
                    callback.call(AudioEvent { state: "pcm".into(), pcm: Some(Float32Array::new(vec![0.0; CHUNK_SAMPLES])), reason: None }, ThreadsafeFunctionCallMode::NonBlocking);
                }
            };
            let _ = client.Stop();
            outcome
        })();
        let _ = CloseHandle(event);
        result
    }
}
