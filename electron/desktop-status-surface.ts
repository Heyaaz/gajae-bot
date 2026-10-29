import {
  app,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import type { DesktopStatusSurface, StatusMenuEntry } from "./desktop-status.js";

export interface ElectronStatusSurfaceOptions {
  /** The menu bar template image; its `@2x` sibling is loaded with it. */
  iconPath: string;
  openSession(sessionId: string): void;
  openApp(): void;
}

export function electronStatusSurface(
  options: ElectronStatusSurfaceOptions,
): DesktopStatusSurface {
  let tray: Tray | null = null;
  let icon: NativeImage | undefined;
  return {
    setTray(model) {
      if (!model) {
        tray?.destroy();
        tray = null;
        return;
      }
      icon ??= menuBarIcon(options.iconPath);
      tray ??= new Tray(icon);
      // Without an image an empty title would leave an invisible, unclickable item.
      tray.setTitle(model.title || (icon.isEmpty() ? "Gajae" : ""));
      tray.setToolTip(model.tooltip);
      tray.setContextMenu(
        Menu.buildFromTemplate(model.menu.map((entry) => menuItem(entry, options))),
      );
    },
    setBadge(badge) {
      app.dock?.setBadge(badge);
    },
  };
}

function menuItem(
  entry: StatusMenuEntry,
  options: ElectronStatusSurfaceOptions,
): MenuItemConstructorOptions {
  switch (entry.kind) {
    case "heading":
      return { label: entry.label, enabled: false };
    case "session":
      return { label: entry.label, click: () => options.openSession(entry.sessionId) };
    case "separator":
      return { type: "separator" };
    case "open-app":
      return { label: entry.label, click: () => options.openApp() };
  }
}

/**
 * The menu bar image: Gajae's figure (antennae, straw hat, goggles, cloak) drawn
 * as an 18pt silhouette. Derived from the app icon it read as noise at this size.
 * The `Template` file name makes macOS tint it for the menu bar's appearance.
 */
export function menuBarIcon(iconPath: string): NativeImage {
  const image = nativeImage.createFromPath(iconPath);
  // A missing icon leaves a title-only item rather than no menu bar status at all.
  if (!image.isEmpty()) image.setTemplateImage(true);
  return image;
}
