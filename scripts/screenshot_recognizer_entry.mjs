import { createRecognizer } from '@scoriiu/fenshot';
import * as ort from 'onnxruntime-web/wasm';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let recognizer;
let busy = false;
const assetRoot = new URL('./', import.meta.url);

export async function recognize(file) {
  if (!(file instanceof Blob)) throw new Error('Choose an image file to scan.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP screenshot.');
  }
  if (!file.size || file.size > 10 * 1024 * 1024) {
    throw new Error('The screenshot must be smaller than 10 MB.');
  }
  if (busy) throw new Error('A screenshot is already being scanned.');
  busy = true;
  let bitmap;
  let scanStarted = false;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width < 80 || bitmap.height < 80) {
      throw new Error('The screenshot is too small to read.');
    }
    if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 16000000) {
      throw new Error('Crop or resize the screenshot to 16 megapixels or less.');
    }
    recognizer ||= createRecognizer({
      modelUrl: new URL('chess-tiles-v2.onnx', assetRoot).href,
      wasmPaths: new URL('ort/', assetRoot).href,
    });
    scanStarted = true;
    const result = await recognizer.recognize(bitmap);
    if (!result) return null;
    // Keep the pixel orientation intact: only the user can confirm which side is at the bottom.
    return {
      ...result,
      plausible: result.placement.split('K').length === 2 && result.placement.split('k').length === 2,
      orientation: 'white',
    };
  } catch (error) {
    if (scanStarted) recognizer = undefined;
    throw error;
  } finally {
    bitmap?.close();
    busy = false;
  }
}
