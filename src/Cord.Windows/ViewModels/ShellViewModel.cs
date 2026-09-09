using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Cord.Core;

namespace Cord.Windows.ViewModels;

public partial class ShellViewModel : ObservableObject
{
    [ObservableProperty] public partial string Name { get; set; } = "Ваше пространство";
    [ObservableProperty] public partial string ServerLabel { get; set; } = "Подключаемся…";
    [ObservableProperty] public partial string Status { get; set; } = "На одной волне";
    [ObservableProperty] public partial string Error { get; set; } = "";
    [ObservableProperty] public partial bool HasError { get; set; }
    [ObservableProperty] public partial bool InCall { get; set; }
    [ObservableProperty] public partial bool Loading { get; set; } = true;
    public string Version => "Cord " + Services.ApplicationUpdater.DisplayVersion;
    [ObservableProperty] public partial string UpdateStatus { get; set; } = "";
    [ObservableProperty] public partial string UpdateButton { get; set; } = "Обновить";
    [ObservableProperty] public partial bool UpdateAvailable { get; set; }
    [ObservableProperty] public partial bool UpdateBusy { get; set; }
    [ObservableProperty] public partial double UpdateProgress { get; set; }
    public ObservableCollection<FavoriteRoom> Favorites { get; } = [];

    public void ReplaceFavorites(IEnumerable<FavoriteRoom> rooms)
    {
        Favorites.Clear();
        foreach (var room in rooms) Favorites.Add(room);
    }
    public void Report(string message) { Error = message; HasError = true; }
}
