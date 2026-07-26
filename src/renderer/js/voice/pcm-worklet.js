// AudioWorkletProcessor — классический скрипт (БЕЗ import/export).
// Загружается через audioContext.audioWorklet.addModule().
// Копирует каждый входной чанк Float32 и шлёт его в основной поток.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const copy = new Float32Array(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true; // держать процессор живым
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
