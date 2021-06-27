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

export default class Logger {
  protected LogFunction?: LogFunction;
  protected username?: string;
  constructor(logFunction: LogFunction, username?: string) {
    this.LogFunction = logFunction;
    this.username = username;
  }
  public log(opts: LogOptions) {
    const msg = [
      opts.username || this.username,
      opts.msg,
      opts.args ? Object.keys(opts.args).map((key) => {
        return `key: ${opts.args[key]}`;
      }).join(', ') : null
    ].filter((s) => s).join(' - ');
    this.LogFunction?.({
      username: this.username,
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
  }
}
