export type LogLevels = 'debug' | 'info' | 'error';
export type LogArgs = {
  [key: string]: string | number | boolean;
};
export type LogOptions = {
  level: LogLevels;
  username?: string;
  msg?: string;
  args?: LogArgs;
  err?: Error;
};
export type LogFunction = (opts: LogOptions) => void;
export type Callbacks = {
  onAddUser?: (opts: { username: string }) => void;
  onLogin?: (opts: { username: string }) => void;
  onDisconnect?: (opts: { username: string }) => void;
  onError?: (opts: { username?: string, msg: string, err?: Error }) => void;
  onPut?: (opts: { username: string, path: string }) => void;
  onGet?: (opts: { username: string, path: string }) => void;
  onRm?: (opts: { username: string, path: string }) => void;
  onRmdir?: (opts: { username: string, path: string }) => void;
  onMkdir?: (opts: { username: string, path: string }) => void;
  onRename?: (opts: { username: string, oldPath: string, newPath: string }) => void;
};
type CallbackFunction = keyof Callbacks;
type CallbackOpts<T extends CallbackFunction> = Parameters<Callbacks[T]>[0];
type CallbackFunctionOptsReqUser = {
  [K in CallbackFunction]: CallbackOpts<K> extends { username: string } ? K : never;
}[CallbackFunction];
type OptionalUsername<T extends { username: string }> = Omit<T, 'username'> & Partial<Pick<T, 'username'>>;
type CallbackFunctionOptUser = {
  [K in CallbackFunction]: K extends CallbackFunctionOptsReqUser ?
    OptionalUsername<CallbackOpts<K>> : CallbackOpts<K>;
};

// type CaseStringKeys = {
//   [K in keyof BaseCase]: BaseCase[K] extends string ? K : never; 
// }[keyof BaseCase];

export default class Logger {
  protected LogFunction?: LogFunction;
  protected Callbacks?: Callbacks;
  protected username?: string;
  constructor(logFunction: LogFunction, callbacks?: Callbacks, username?: string) {
    this.LogFunction = logFunction;
    this.Callbacks = callbacks;
    this.username = username;
  }
  protected getUsername(opts: { username?: string }) {
    return opts.username || this.username;
  }
  protected getMsg(opts: Pick<LogOptions, 'username' | 'msg' | 'args'>) {
    return [
      this.getUsername(opts),
      opts.msg,
      opts.args ? Object.keys(opts.args).map((key) => {
        return `${key}: ${opts.args[key]}`;
      }).join(', ') : null
    ].filter((s) => s).join(' - ');
  }
  public log(opts: LogOptions) {
    const msg = this.getMsg(opts);
    this.LogFunction?.({
      username: this.getUsername(opts),
      ...opts,
      msg
    });
  }
  public debug(opts: Omit<LogOptions, 'level'>) {
    this.log({ ...opts, level: 'debug' });
  }
  public info(opts: Omit<LogOptions, 'level'>) {
    this.log({ ...opts, level: 'info' });
  }
  public error(opts: Omit<LogOptions, 'level' | 'err'> & Required<Pick<LogOptions, 'err'>>) {
    this.log({ ...opts, level: 'error' });
    this.onError({
      username: this.getUsername(opts),
      msg: this.getMsg(opts),
      err: opts.err
    });
  }
  // protected onCallback<T extends CallbackFunction, P extends Parameters<Callbacks[T]>[0]>(name: T, opts: P) {
  //   try {
  //     // @ts-ignore
  //     this.Callbacks?.[name]?.(opts);
  //   } catch(err) {
  //     this.error({ err, msg: `Error calling ${name}` });
  //   }
  // }
  public onAddUser(opts: CallbackFunctionOptUser['onAddUser']) {
    // this.onCallback('onAddUser', opts);
    try {
      this.Callbacks?.onAddUser?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onAddUser' });
    }
  }
  public onLogin(opts: CallbackFunctionOptUser['onLogin']) {
    // this.onCallback('onLogin', opts);
    try {
      this.Callbacks?.onLogin?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onLogin' });
    }
  }
  public onDisconnect(opts: CallbackFunctionOptUser['onDisconnect']) {
    // this.onCallback('onDisconnect', opts);
    try {
      this.Callbacks?.onDisconnect?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onDisconnect' });
    }
  }
  protected onError(opts: CallbackFunctionOptUser['onError']) {
    // this.onCallback('onError', opts);
    try {
      this.Callbacks?.onError?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onError' });
    }
  }
  public onPut(opts: CallbackFunctionOptUser['onPut']) {
    // this.onCallback('onPut', opts);
    try {
      this.Callbacks?.onPut?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onPut' });
    }
  }
  public onGet(opts: CallbackFunctionOptUser['onGet']) {
    // this.onCallback('onGet', opts);
    console.log('here');
    try {
      this.Callbacks?.onGet?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onGet' });
    }
  }
  public onRm(opts: CallbackFunctionOptUser['onRm']) {
    // this.onCallback('onRm', opts);
    try {
      this.Callbacks?.onRm?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onRm' });
    }
  }
  public onRmdir(opts: CallbackFunctionOptUser['onRmdir']) {
    // this.onCallback('onRmdir', opts);
    try {
      this.Callbacks?.onRmdir?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onRmdir' });
    }
  }
  public onMkdir(opts: CallbackFunctionOptUser['onMkdir']) {
    // this.onCallback('onMkdir', opts);
    try {
      this.Callbacks?.onMkdir?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onMkdir' });
    }
  }
  public onRename(opts: CallbackFunctionOptUser['onRename']) {
    // this.onCallback('onRename', opts);
    try {
      this.Callbacks?.onRename?.({ ...opts, username: this.getUsername(opts) });
    } catch(err) {
      this.error({ err, msg: 'Error calling onRename' });
    }
  }
}
