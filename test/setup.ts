import { File } from 'node:buffer';

if (!globalThis.File) {
  globalThis.File = File;
}
