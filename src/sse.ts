// A small server-sent events reader over a fetch body, following the WHATWG event-stream parsing
// rules: lines end in CRLF, LF or CR; a blank line dispatches; `:` starts a comment; `data` lines are
// joined with LF; `id` sets the resume cursor unless it contains NUL. One difference from a browser:
// a named event without data is still dispatched.

export interface SseEvent {
  event: string;
  data: string;
  id: string | undefined;
}

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  private sawCr = false;
  /** The last `id:` seen, carried across events as the spec's "last event ID". */
  lastEventId: string | undefined;
  /** A `retry:` value, in milliseconds, if the server sent one. */
  retryMs: number | undefined;

  /** Feeds a chunk of decoded text and returns the events it completed. */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    let text = chunk;
    // A CR at the end of the previous chunk may be the first half of a CRLF.
    if (this.sawCr && text.startsWith('\n')) text = text.slice(1);
    this.sawCr = false;
    this.buffer += text;
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buffer);
      if (!m) break;
      if (m[0] === '\r' && m.index === this.buffer.length - 1) {
        // Could be CRLF split across chunks: take the line, remember to drop a leading LF next time.
        this.sawCr = true;
      }
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.id !== undefined) this.lastEventId = this.id === '' ? undefined : this.id;
    // Unlike a browser, an event with a name but no data is still passed on: swarmsay's `closed` may
    // carry none, and the CLI must see it.
    const dispatchable = this.data.length > 0 || this.event !== '';
    const ev: SseEvent = { event: this.event || 'message', data: this.data.join('\n'), id: this.lastEventId };
    this.data = [];
    this.event = '';
    this.id = undefined;
    return dispatchable ? ev : undefined;
  }
}
