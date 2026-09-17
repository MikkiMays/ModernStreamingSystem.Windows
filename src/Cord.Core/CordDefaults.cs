namespace Cord.Core;

/// <summary>
/// Everything that ties a build of Cord to one operator. A fork changes these two values
/// and nothing else: the rest of the client is server-agnostic.
/// </summary>
public static class CordDefaults
{
    /// <summary>The server a fresh installation starts on. Users may add or replace it.</summary>
    public const string ServerUrl = "https://meet.nikg.tech/";

    /// <summary>
    /// Запасной источник обновления, когда GitHub недоступен.
    ///
    /// Раньше он был основным: репозиторий был закрытым, и анонимный клиент никакого другого
    /// источника не имел. Репозиторий публичный, релиз выпускает GitHub — он и спрашивается
    /// первым, а зеркало осталось для случая, когда до GitHub не достучаться.
    ///
    /// Адрес намеренно НЕ следует за выбранным сервером встреч: вход в чужую комнату не должен
    /// решать, какой исполняемый файл поставится на эту машину.
    /// </summary>
    public static readonly Uri UpdateMirror =
        new("https://meet.nikg.tech/downloads/windows/latest.json");
}
