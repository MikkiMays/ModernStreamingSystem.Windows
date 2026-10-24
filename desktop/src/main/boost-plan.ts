/**
 * Приоритет звука во встрече (R01–R03, ADR 0001 §2.1). Windows 11 переводит фоновые процессы в
 * EcoQoS («режим эффективности»): ядра попроще, частота ниже, таймер грубее, — а Cord во встрече
 * часто именно фоновый: спрятан в трей (R57) или накрыт игрой. Под нагрузкой игры его звук ещё и
 * уступает ей процессор. Поэтому на время встречи `cord-native` снимает с них EcoQoS и ставит
 * `ABOVE_NORMAL_PRIORITY_CLASS` (`process.boost {pids, on}`), после встречи — возвращает.
 *
 * Поднимаются только свои процессы: главный (окна, мост), рендерер главного окна (страница
 * встречи, WebRTC, `AudioContext`) и аудиосервис Chromium (вывод и захват звука). Вне встречи —
 * ничего: не греть ноутбук. Здесь нет Electron: решения проверяются тестами, `index.ts` их исполняет.
 */

/** Нужное из `app.getAppMetrics()`. */
export interface BoostMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
}

/** Аудиосервис Chromium: служба `audio.mojom.AudioService` («Audio Service»). */
function isAudioService(metric: BoostMetric): boolean {
  return metric.type === 'Utility' && (metric.serviceName === 'audio.mojom.AudioService' || metric.name === 'Audio Service');
}

/**
 * Кого поднимать: `self` — главный процесс, `renderer` — рендерер главного окна
 * (`webContents.getOSProcessId()`), если он есть среди процессов Cord.
 */
export function boostTargets(metrics: readonly BoostMetric[], self: number, renderer: number | null): number[] {
  const alive = new Set(metrics.map((metric) => metric.pid));
  const targets = [self];
  if (renderer !== null && alive.has(renderer)) targets.push(renderer);
  for (const metric of metrics) if (isAudioService(metric)) targets.push(metric.pid);
  return [...new Set(targets)];
}

/**
 * Что поменять: во встрече — поднять недостающих и вернуть тех, кто перестал быть целью (рендерер
 * сменился); вне встречи — вернуть всех. Возвращаются только живые процессы Cord (`alive`): номер
 * умершего мог достаться чужому процессу.
 */
export function planBoost(inCall: boolean, targets: readonly number[], boosted: ReadonlySet<number>, alive: readonly number[]): { on: number[]; off: number[] } {
  const living = new Set(alive);
  const wanted = new Set(inCall ? targets : []);
  return {
    on: [...wanted].filter((pid) => !boosted.has(pid)),
    off: [...boosted].filter((pid) => !wanted.has(pid) && living.has(pid)),
  };
}
