// 第三方模块声明补全：部分运行时依赖未随附 .d.ts，tsx 运行无需，类型检查用 any 兜底。
// 注意：本文件必须是 .ts（非 .d.ts），因为仓库 .gitignore 把 server/**/*.d.ts 当作构建产物忽略。

declare module 'nodemailer' {
  const x: any;
  export = x;
}

declare module 'ws' {
  type RawData = Buffer | ArrayBuffer | Buffer[];
  class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;
    constructor(url: string, protocols?: string | string[]);
    on(event: 'open' | 'error' | 'close', listener: (arg?: any) => void): this;
    on(event: 'message', listener: (data: RawData) => void): this;
    send(data: string): void;
    close(): void;
    readyState: number;
  }
  namespace WebSocket {
    type RawData = Buffer | ArrayBuffer | Buffer[];
  }
  export = WebSocket;
}
