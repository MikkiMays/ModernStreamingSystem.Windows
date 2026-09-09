#ifndef PublishRoot
  #error PublishRoot must point to the verified self-contained publication.
#endif
#ifndef RedistRoot
  #error RedistRoot must point to the verified WebView2 standalone installer.
#endif
#ifndef ArtifactRoot
  #error ArtifactRoot is required.
#endif
#ifndef AppVersion
  #error AppVersion must match the application assembly version.
#endif

[Setup]
AppId={{E43CC1FC-827B-4F55-A8E8-C746D4BAE102}
AppName=Cord
AppVersion={#AppVersion}
AppPublisher=Cord
AppVerName=Cord {#AppVersion}
DefaultDirName={localappdata}\Programs\Cord
DefaultGroupName=Cord
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#ArtifactRoot}
OutputBaseFilename=Cord-Setup-{#AppVersion}-x64
SetupIconFile={#PublishRoot}\Assets\Cord.ico
UninstallDisplayIcon={app}\Cord.exe
UninstallDisplayName=Cord
WizardStyle=modern dynamic windows11
WizardSizePercent=110
Compression=lzma2/normal
SolidCompression=yes
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
AppComments=Звонки, экран и разговоры в одном пространстве.
InfoBeforeFile=About-installation.txt

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked

[Files]
Source: "{#RedistRoot}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Flags: dontcopy nocompression
Source: "{#PublishRoot}\*"; DestDir: "{app}"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "About-installation.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Cord"; Filename: "{app}\Cord.exe"; WorkingDir: "{app}"; Check: not WizardNoIcons
Name: "{autodesktop}\Cord"; Filename: "{app}\Cord.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Cord.exe"; Description: "Открыть Cord"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebViewKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function RuntimeVersionPresent(Root: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, WebViewKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function HasWebView2: Boolean;
begin
  Result := RuntimeVersionPresent(HKLM32) or RuntimeVersionPresent(HKCU);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if HasWebView2 then exit;
  WizardForm.StatusLabel.Caption := 'Устанавливаем Microsoft Edge WebView2 Runtime…';
  ExtractTemporaryFile('MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe'),
    '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
  begin
    Result := 'Не удалось запустить установку WebView2. Повторите установку Cord.';
    exit;
  end;
  if ExitCode = 3010 then
  begin
    NeedsRestart := True;
    Result := 'WebView2 установлен. Перезагрузите Windows и запустите установку Cord снова.';
    exit;
  end;
  if not HasWebView2 then
    Result := Format('WebView2 не удалось установить (код %d). Проверьте ограничения установки в Windows и повторите попытку.', [ExitCode]);
end;

// No UninstallDelete for the user's profile or the shared WebView2 Runtime.
// Removing Cord must preserve cached names, favorites and other applications' runtime.
