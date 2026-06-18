declare module 'snappyjs' {
  export function uncompress(buffer: Uint8Array | ArrayBuffer): Uint8Array;
  export function compress(buffer: Uint8Array | ArrayBuffer): Uint8Array;
}
