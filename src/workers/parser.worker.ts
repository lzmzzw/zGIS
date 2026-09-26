import { importFiles } from "../domain";
import type { ImportOptions, InputFile } from "../domain";
self.onmessage = async (
  event: MessageEvent<{ files: InputFile[]; options: ImportOptions }>,
) => {
  try {
    self.postMessage({
      layers: await importFiles(event.data.files, event.data.options),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
