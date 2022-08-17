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
  onPut?: (opts: { username?: string, path: string }) => void;
  onGet?: (opts: { username?: string, path: string }) => void;
  onRm?: (opts: { username?: string, path: string }) => void;
  onRmdir?: (opts: { username?: string, path: string }) => void;
  onMkdir?: (opts: { username?: string, path: string }) => void;
  onRename?: (opts: { username?: string, oldPath: string, newPath: string }) => void;
};
type CallbackFunction = keyof Callbacks;
type CallbackOpts<T extends CallbackFunction> = Parameters<Callbacks[T]>[0];

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
  protected onCallback<T extends CallbackFunction, P extends Parameters<Callbacks[T]>[0]>(name: T, opts: P) {
    try {
      // @ts-ignore
      this.Callbacks?.[name]?.(opts);
    } catch(err) {
      this.error({ err, msg: `Error calling ${name}` });
    }
  }
  public onAddUser(opts: CallbackOpts<'onAddUser'>) {
    this.onCallback('onAddUser', opts);
  }
  public onLogin(opts: CallbackOpts<'onLogin'>) {
    this.onCallback('onLogin', opts);
  }
  public onDisconnect(opts: CallbackOpts<'onDisconnect'>) {
    this.onCallback('onDisconnect', opts);
  }
  protected onError(opts: CallbackOpts<'onError'>) {
    this.onCallback('onError', opts);
  }
  public onPut(opts: CallbackOpts<'onPut'>) {
    this.onCallback('onPut', opts);
  }
  public onGet(opts: CallbackOpts<'onGet'>) {
    this.onCallback('onGet', opts);
  }
  public onRm(opts: CallbackOpts<'onRm'>) {
    this.onCallback('onRm', opts);
  }
  public onRmdir(opts: CallbackOpts<'onRmdir'>) {
    this.onCallback('onRmdir', opts);
  }
  public onMkdir(opts: CallbackOpts<'onMkdir'>) {
    this.onCallback('onMkdir', opts);
  }
  public onRename(opts: CallbackOpts<'onRename'>) {
    this.onCallback('onRename', opts);
  }
}
