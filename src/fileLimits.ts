import { isTauri } from "@tauri-apps/api/core";

export const MAX_DESKTOP_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_WEB_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_BYTES = isTauri() ? MAX_DESKTOP_FILE_BYTES : MAX_WEB_FILE_BYTES;
