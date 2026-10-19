using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Cord.Core;
using Microsoft.UI.Xaml.Media;

namespace Cord.Windows.ViewModels;

public partial class ShellViewModel : ObservableObject
{
    [ObservableProperty] public partial string Name { get; set; } = "Ваше пространство";
    /// <summary>The picture the page keeps for this server. Null shows the placeholder behind it.</summary>
    [ObservableProperty] public partial ImageSource? Avatar { get; set; }
    [ObservableProperty] public partial string ServerLabel { get; set; } = "Подключаемся…";
    [ObservableProperty] public partial string Status { get; set; } = "На одной волне";
    [ObservableProperty] public partial string Error { get; set; } = "";
    [ObservableProperty] public partial bool HasError { get; set; }
    [ObservableProperty] public partial bool InCall { get; set; }
    [ObservableProperty] public partial bool Loading { get; set; } = true;
    /// <summary>Что сказать про обновление в «О программе» — единственном месте, где видна версия (T58).</summary>
    [ObservableProperty] public partial string UpdateStatus { get; set; } = "";
    /// <summary>В «О программе» есть кнопка «Обновить»: человек после сбоя остался в этой версии.</summary>
    [ObservableProperty] public partial bool UpdateAvailable { get; set; }
    /// <summary>Экран «Обновление Cord…» во всё окно (T58). Закрыть его, кроме как сбоем, нельзя.</summary>
    [ObservableProperty] public partial bool UpdateForced { get; set; }
    [ObservableProperty] public partial string UpdateTitle { get; set; } = "Обновление Cord…";
    [ObservableProperty] public partial string UpdatePhase { get; set; } = "";
    [ObservableProperty] public partial double UpdateProgress { get; set; }
    /// <summary>Сколько осталось, неизвестно: проверка и установка, а не загрузка.</summary>
    [ObservableProperty] public partial bool UpdateIndeterminate { get; set; } = true;
    /// <summary>Идёт работа — видна полоса; сбой — видны «Повторить» и «Продолжить в этой версии».</summary>
    [ObservableProperty] public partial bool UpdateWorking { get; set; } = true;
    [ObservableProperty] public partial bool UpdateFailed { get; set; }
    public ObservableCollection<FavoriteRoom> Favorites { get; } = [];

    public void ReplaceFavorites(IEnumerable<FavoriteRoom> rooms)
    {
        Favorites.Clear();
        foreach (var room in rooms) Favorites.Add(room);
    }
    public void Report(string message) { Error = message; HasError = true; }
    /// <summary>Итог прошлого обновления — своей плашкой: в «Соединении» с кнопкой «Открыть повторно» он читался как сбой сервера.</summary>
    [ObservableProperty] public partial string UpdateNotice { get; set; } = "";
    [ObservableProperty] public partial bool HasUpdateNotice { get; set; }
    [ObservableProperty] public partial Microsoft.UI.Xaml.Controls.InfoBarSeverity UpdateSeverity { get; set; }
    public void ReportUpdate(bool ok, string message)
    {
        UpdateNotice = message;
        UpdateSeverity = ok ? Microsoft.UI.Xaml.Controls.InfoBarSeverity.Success : Microsoft.UI.Xaml.Controls.InfoBarSeverity.Warning;
        HasUpdateNotice = true;
    }
}
