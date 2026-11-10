// Reads the text of an order screenshot in the browser (tesseract.js), then
// tidies it with cleanOcrText so parseOrderText can read it. The library
// and its English data (~5 MB, fetched once, then cached by the browser)
// load only the first time someone uses a screenshot.

import { cleanOcrText, textFromOcrLayout } from "./orderTextParser.js";

let workerPromise = null;
let progress = () => {}; // the current read's progress callback

export async function readOrderImage(image, onProgress = () => {}) {
  progress = onProgress;
  if (!workerPromise) {
    workerPromise = import("tesseract.js").then(({ createWorker }) =>
      createWorker("eng", 1, {
        logger: (m) => m.status === "recognizing text" && progress(m.progress),
      })
    );
    workerPromise.catch(() => (workerPromise = null)); // let the next try load it again
  }
  const worker = await workerPromise;
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  return cleanOcrText(textFromOcrLayout(lines) ?? data.text);
}

// The first image in a paste event, if any.
export const imageFromClipboard = (e) =>
  [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"))?.getAsFile() || null;
