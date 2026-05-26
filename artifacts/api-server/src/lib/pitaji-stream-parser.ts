// Incremental parser for the Pita Ji analysis stream.
//
// Gemini returns a single JSON object of shape `{ "clips": [ ... ] }` when we
// pin `responseMimeType: "application/json"`. We feed the model's output
// chunks into this parser, which:
//
//   1. Skips everything until the opening `{ "clips": [`.
//   2. Walks the inside of the array and, for every top-level object that
//      reaches balanced braces, emits the parsed object.
//   3. Stops once the closing `]` is seen.
//
// The parser is string-aware (correctly handles `{` / `}` inside JSON strings
// and skips escapes). It never blocks the SSE write — chunks unrelated to
// clip boundaries are simply buffered.

type ClipPhase =
  | "search-array-open" // before we've located the opening `[`
  | "in-array"          // inside the array, waiting for next object or `]`
  | "in-object"         // collecting an object until balanced
  | "done";

export interface PitajiStreamParseResult<T> {
  /** Newly-completed objects emitted by this chunk. */
  emitted: T[];
  /** True once we've seen the closing array bracket. */
  done: boolean;
  /** True if we ever saw the opening `[`. Useful to distinguish format errors. */
  sawArray: boolean;
}

export class PitajiClipStreamParser<T = unknown> {
  private phase: ClipPhase = "search-array-open";
  private buffer = "";
  /** When in "in-object", the start index in `buffer` of the current object. */
  private objStart = -1;
  /** Brace depth inside the current object (1 = outermost). */
  private depth = 0;
  /** Whether the cursor is currently inside a JSON string literal. */
  private inString = false;
  /** Whether the previous character was an unconsumed escape `\`. */
  private escapeNext = false;
  /** Whether we've seen the opening `[` yet. */
  private sawArray = false;

  /**
   * Feed a fresh text chunk from the model. Returns any clip objects whose
   * braces became balanced inside this chunk.
   */
  push(chunk: string): PitajiStreamParseResult<T> {
    if (this.phase === "done") {
      return { emitted: [], done: true, sawArray: this.sawArray };
    }
    if (!chunk) return { emitted: [], done: false, sawArray: this.sawArray };

    this.buffer += chunk;
    const out: T[] = [];

    // Walk characters from where we left off — for objStart we use absolute
    // indexes in `buffer` (we never shrink the buffer mid-object). After we
    // emit each completed object, we slice everything up to its end so the
    // working buffer stays small.
    let i = this.phase === "in-object" ? this.objStart + 1 + (this.computeOffsetIntoObj()) : this.cursorIntoBuffer();

    for (; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];

      switch (this.phase) {
        case "search-array-open": {
          if (ch === "[") {
            this.phase = "in-array";
            this.sawArray = true;
          }
          break;
        }
        case "in-array": {
          if (ch === "]") {
            this.phase = "done";
            i = this.buffer.length; // stop the loop
            break;
          }
          if (ch === "{") {
            this.phase = "in-object";
            this.objStart = i;
            this.depth = 1;
            this.inString = false;
            this.escapeNext = false;
          }
          // Whitespace and commas are simply skipped while between objects.
          break;
        }
        case "in-object": {
          if (this.escapeNext) {
            this.escapeNext = false;
            break;
          }
          if (this.inString) {
            if (ch === "\\") this.escapeNext = true;
            else if (ch === '"') this.inString = false;
            break;
          }
          if (ch === '"') { this.inString = true; break; }
          if (ch === "{") { this.depth += 1; break; }
          if (ch === "}") {
            this.depth -= 1;
            if (this.depth === 0) {
              const raw = this.buffer.slice(this.objStart, i + 1);
              try {
                const parsed = JSON.parse(raw) as T;
                out.push(parsed);
              } catch {
                // Malformed object — drop and continue. The model rarely emits
                // partial garbage when responseMimeType is JSON, but if it does
                // we'd rather skip one clip than abort the whole stream.
              }
              // Compact the buffer — drop everything we've already consumed.
              this.buffer = this.buffer.slice(i + 1);
              i = -1; // reset; loop will i++ to 0
              this.phase = "in-array";
              this.objStart = -1;
            }
          }
          break;
        }
        case "done":
          break;
      }
    }

    if (this.phase !== "in-object" && this.objStart === -1 && this.phase !== "done") {
      // Compact the buffer further — drop anything before the next char to
      // examine. With "search-array-open" we may keep a long preamble that we
      // don't need; trim it but keep one char of look-behind just in case.
      if (this.phase === "search-array-open" && this.buffer.length > 4096) {
        this.buffer = this.buffer.slice(-1024);
      }
      if (this.phase === "in-array" && this.buffer.length > 4096) {
        this.buffer = this.buffer.slice(-1024);
      }
    }

    return { emitted: out, done: this.phase === "done", sawArray: this.sawArray };
  }

  isDone(): boolean {
    return this.phase === "done";
  }

  hasSeenArray(): boolean {
    return this.sawArray;
  }

  private cursorIntoBuffer(): number {
    // After buffer slicing above, we always restart from index 0.
    return 0;
  }

  // We don't actually use a separate offset — kept for symmetry / clarity.
  private computeOffsetIntoObj(): number {
    return 0;
  }
}
