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
    /// <summary>В «О программе» есть кнопка «Обновить»: человек открыл Cord мимо сбоя на заставке.</summary>
    [ObservableProperty] public partial bool UpdateAvailable { get; set; }
    public ObservableCollection<FavoriteRoom> Favorites { get; } = [];

    public void ReplaceFavorites(IEnumerable<FavoriteRoom> rooms)
    {
        Favorites.Clear();
        foreach (var room in rooms) Favorites.Add(room);
    }
    public void Report(string message) { Error = message; HasError = true; }
}
