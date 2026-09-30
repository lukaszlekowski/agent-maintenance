declare module 'fs-ext' {
  export function flock(
    fd: number,
    flags: 'exnb' | 'un',
    callback: (error?: NodeJS.ErrnoException | null) => void,
  ): void;
}
