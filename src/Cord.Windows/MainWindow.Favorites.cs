using System.Net;
using Cord.Core;
using Cord.Windows.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;

namespace Cord.Windows;

public sealed partial class MainWindow
{
    private bool _favoriteDragging;
    private bool _favoriteOrderSaving;
    private long _suppressFavoriteOpenUntil;
    private FavoriteRoom[]? _favoriteDragOrder;
    private WebWorkspace? _favoriteDragWorkspace;

    private void ReplaceFavoriteRows(IEnumerable<FavoriteRoom> rooms)
    {
        var selectedId = (FavoriteList.SelectedItem as FavoriteRoom)?.RoomId;
        var focus = FavoriteList.XamlRoot is { } xamlRoot
            ? FocusManager.GetFocusedElement(xamlRoot) as DependencyObject : null;
        var restoreFocus = false;
        for (var current = focus; current is not null; current = VisualTreeHelper.GetParent(current))
            if (current == FavoriteList) { restoreFocus = true; break; }
        Model.ReplaceFavorites(rooms);
        var selected = Model.Favorites.FirstOrDefault(room => room.RoomId == selectedId);
        FavoriteList.SelectedItem = selected;
        if (restoreFocus && selected is not null)
        {
            FavoriteList.UpdateLayout();
            if (FavoriteList.ContainerFromItem(selected) is Control item) item.Focus(FocusState.Keyboard);
            else FavoriteList.Focus(FocusState.Keyboard);
        }
    }

    private void CancelFavoriteDrag()
    {
        _favoriteDragging = false;
        _favoriteDragOrder = null;
        _favoriteDragWorkspace = null;
        ++_favoriteRevision;
    }

    private void Favorites_DragItemsStarting(object sender, DragItemsStartingEventArgs e)
    {
        if (_favoriteOrderSaving || _workspace?.Capability.Length != 43 || e.Items.Count != 1)
        {
            e.Cancel = true;
            return;
        }
        _favoriteDragging = true;
        ++_favoriteRevision; // An earlier refresh must not replace a list during the gesture.
        _favoriteDragWorkspace = _workspace;
        _favoriteDragOrder = Model.Favorites.ToArray();
        e.Data.RequestedOperation = DataPackageOperation.Move;
    }

    private void Favorites_DragItemsCompleted(ListViewBase sender, DragItemsCompletedEventArgs e)
    {
        var before = _favoriteDragOrder;
        var workspace = _favoriteDragWorkspace;
        _favoriteDragOrder = null;
        _favoriteDragWorkspace = null;
        _favoriteDragging = false;
        _suppressFavoriteOpenUntil = Environment.TickCount64 + 350;
        if (_closed) return;
        if (before is null || workspace != _workspace)
        {
            Run(RefreshFavoritesAsync);
            return;
        }
        if (e.DropResult != DataPackageOperation.Move)
        {
            ReplaceFavoriteRows(before);
            Run(RefreshFavoritesAsync);
            return;
        }
        Run(() => SaveFavoriteOrderAsync(workspace!, before));
    }

    private void Favorites_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (_favoriteDragging || _favoriteOrderSaving || Environment.TickCount64 < _suppressFavoriteOpenUntil) return;
        if (e.ClickedItem is FavoriteRoom { CanJoin: true } room)
            Run(() => NavigateAsync("favorite", room.RoomId));
    }

    private void FavoriteUp_Click(object sender, RoutedEventArgs e) => MoveFavorite(sender, -1);
    private void FavoriteDown_Click(object sender, RoutedEventArgs e) => MoveFavorite(sender, 1);
    private void Favorites_ContextRequested(UIElement sender, ContextRequestedEventArgs args)
    {
        var room = (args.OriginalSource as FrameworkElement)?.DataContext as FavoriteRoom
            ?? FavoriteList.SelectedItem as FavoriteRoom;
        if (room is null || _favoriteDragging || _favoriteOrderSaving) return;
        var index = Model.Favorites.IndexOf(room);
        var menu = new MenuFlyout();
        var up = new MenuFlyoutItem { Text = "Выше", Tag = room.RoomId, IsEnabled = index > 0 };
        var down = new MenuFlyoutItem { Text = "Ниже", Tag = room.RoomId, IsEnabled = index >= 0 && index < Model.Favorites.Count - 1 };
        var settings = new MenuFlyoutItem { Text = "Настройки комнаты", Tag = room.RoomId };
        up.Click += FavoriteUp_Click;
        down.Click += FavoriteDown_Click;
        settings.Click += FavoriteMenuSettings_Click;
        menu.Items.Add(up);
        menu.Items.Add(down);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(settings);
        menu.ShowAt(FavoriteList.ContainerFromItem(room) as FrameworkElement ?? FavoriteList);
        args.Handled = true;
    }
    private void FavoriteMenuSettings_Click(object sender, RoutedEventArgs e)
    {
        if (sender is MenuFlyoutItem { Tag: string id }) _workspace?.Post(new("favorite.settings", RoomId: id));
    }

    private void MoveFavorite(object sender, int direction)
    {
        if (_favoriteDragging || _favoriteOrderSaving || _workspace is not { } workspace || sender is not MenuFlyoutItem { Tag: string id }) return;
        var before = Model.Favorites.ToArray();
        var from = Array.FindIndex(before, room => room.RoomId == id);
        var to = from + direction;
        if (from < 0 || to < 0 || to >= before.Length) return;
        Model.Favorites.Move(from, to);
        FavoriteList.SelectedItem = Model.Favorites[to];
        Run(() => SaveFavoriteOrderAsync(workspace, before));
    }

    private async Task SaveFavoriteOrderAsync(WebWorkspace workspace, FavoriteRoom[] before)
    {
        if (workspace != _workspace || _closed) return;
        var ids = Model.Favorites.Select(room => room.RoomId).ToArray();
        if (ids.SequenceEqual(before.Select(room => room.RoomId)))
        {
            await RefreshFavoritesAsync();
            return;
        }
        _favoriteOrderSaving = true;
        ++_favoriteRevision;
        try
        {
            await new FavoriteClient(_http).ReorderAsync(workspace.Endpoint, workspace.Capability, ids, _lifetime.Token, _session?.Token);
            if (workspace == _workspace && !_closed) workspace.Post(new("favorites.changed"));
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            if (workspace == _workspace && !_closed)
            {
                ReplaceFavoriteRows(before);
                Model.Report(error is HttpRequestException { StatusCode: HttpStatusCode.Conflict }
                    ? "Список комнат изменился. Избранное будет обновлено."
                    : error is HttpRequestException { StatusCode: HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed }
                        ? "Этот сервер пока не поддерживает изменение порядка комнат."
                        : "Не удалось сохранить порядок комнат. Попробуйте ещё раз.");
            }
        }
        finally
        {
            _favoriteOrderSaving = false;
        }
        // A different server may have opened while its initial refresh was deferred by this save.
        if (!_closed) await RefreshFavoritesAsync();
    }
}
