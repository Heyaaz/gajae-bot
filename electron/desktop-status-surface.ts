import {
  app,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import {
  templateMask,
  type DesktopStatusSurface,
  type StatusMenuEntry,
} from "./desktop-status.js";

export interface ElectronStatusSurfaceOptions {
  /** The app icon the menu bar image is derived from. */
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

const MENU_BAR_POINTS = 18;
const MASK_SIZE = MENU_BAR_POINTS * 16;
// The icon's own rounded-square frame would otherwise become a box around the
// figure.
const FRAME_INSET = 0.11;

export function menuBarIcon(iconPath: string): NativeImage {
  const source = nativeImage.createFromPath(iconPath);
  // A missing icon leaves a title-only item rather than no menu bar status at all.
  if (source.isEmpty()) return source;
  const { width, height } = source.getSize();
  const inset = Math.round(Math.min(width, height) * FRAME_INSET);
  const figure = source
    .crop({ x: inset, y: inset, width: width - inset * 2, height: height - inset * 2 })
    .resize({ width: MASK_SIZE, height: MASK_SIZE, quality: "best" });
  const mask = nativeImage.createFromBitmap(templateMask(figure.toBitmap()), {
    width: MASK_SIZE,
    height: MASK_SIZE,
  });
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = MENU_BAR_POINTS * scaleFactor;
    const scaled = mask.resize({ width: size, height: size, quality: "best" });
    const solid = nativeImage.createFromBitmap(
      templateMask(scaled.toBitmap(), { opaqueAbove: 64 }),
      { width: size, height: size },
    );
    image.addRepresentation({ scaleFactor, buffer: solid.toPNG() });
  }
  image.setTemplateImage(true);
  return image;
}
