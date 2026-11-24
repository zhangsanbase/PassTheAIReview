class PCMProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate / 20); this.buffer = new Int16Array(this.size); this.offset = 0; this.energy = 0; }
  process(inputs, outputs) {
    const channels = inputs[0];
    const frames = outputs[0]?.[0]?.length || 128;
    for (let i = 0; i < frames; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      value = Math.max(-1, Math.min(1, value / (channels.length || 1)));
      this.buffer[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767)); this.energy += value * value;
      if (this.offset === this.size) {
        this.port.postMessage({ pcm: this.buffer.buffer, level: Math.sqrt(this.energy / this.size) }, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.size); this.offset = 0; this.energy = 0;
      }
    }
    // Output is silence: connecting to the destination keeps the worklet running without replaying captured audio.
    return true;
  }
}
registerProcessor('pcm-capture', PCMProcessor);
