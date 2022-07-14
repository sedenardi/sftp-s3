import { S3Client } from '@aws-sdk/client-s3';
import { AuthContext, Connection, ParsedKey, Server, ServerConfig, utils } from 'ssh2';
import { posix } from 'path';
const { join, normalize } = posix;
import { timingSafeEqual } from 'crypto';
import Logger, { Callbacks, LogFunction } from './logger';
import SFTPSession from './session';

export type ClientKey = {
  username: string;
  key: ParsedKey;
  path: string;
};
type HostKeys = ServerConfig['hostKeys'];

export default class SFTPServer {
  protected S3Client: S3Client;
  protected S3Bucket: string;
  protected HostKeys: HostKeys;
  protected LogFunction: LogFunction;
  protected Callbacks?: Callbacks;

  protected Logger: Logger;
  protected ClientKeys: ClientKey[];
  protected SSHServer: Server;
  constructor(opts: {
    S3Client: S3Client,
    S3Bucket: string,
    HostKeys: HostKeys,
    LogFunction?: LogFunction,
    Callbacks?: Callbacks
  }) {
    this.S3Client = opts.S3Client;
    this.S3Bucket = opts.S3Bucket;
    this.HostKeys = opts.HostKeys;
    this.LogFunction = opts.LogFunction;
    this.Callbacks = opts.Callbacks;
    this.Logger = new Logger(opts.LogFunction, opts.Callbacks);

    this.ClientKeys = [];
  }
  public addClientKey(username: string, key: string | Buffer, namespace?: string) {
    const pubKey = utils.parseKey(key);
    if (pubKey instanceof Error) {
      throw pubKey;
    }
    
    let path = normalize(username);
    if (namespace) {
      path = join(normalize(namespace), path);
    }

    this.ClientKeys.push({
      username: username,
      key: pubKey,
      path: path
    });
    this.Logger.info({ username: username, msg: `Added public key at path ${path}` });
    this.Logger.onAddUser({ username });
  }
  protected authHandler(ctx: AuthContext, clientKey: ClientKey) {
    if (ctx.method !== 'publickey') {
      this.Logger.error({ username: ctx.username, err: null, msg: 'rejecting non-public-key authentication' });
      return ctx.reject(['publickey']);
    }
    if (!clientKey) {
      this.Logger.error({ username: ctx.username, err: null, msg: 'public key not found for user' });
      return ctx.reject(['publickey']);
    }
    const clientKeyMatch = (
      ctx.key.algo === clientKey.key.type  &&
      timingSafeEqual(ctx.key.data, Buffer.from(clientKey.key.getPublicSSH()))
    );
    if (!clientKeyMatch) {
      this.Logger.error({ username: ctx.username, err: null, msg: 'matching public key not found' });
      return ctx.reject(['publickey']);
    }
    if (ctx.signature) {
      const signatureVerified = clientKey.key.verify(ctx.blob, ctx.signature);
      if (signatureVerified) {
        this.Logger.debug({ username: ctx.username, msg: 'signature verified' });
        return ctx.accept();
      } else {
        this.Logger.error({ username: ctx.username, err: null, msg: 'signature rejected' });
        return ctx.reject();
      }
    } else {
      this.Logger.debug({ username: ctx.username, msg: 'no signature present' });
      return ctx.accept();
    }
  }
  protected connectionListener(client: Connection) {
    let clientKey: ClientKey = null;
    client.on('error', (err) => {
      this.Logger.error({ username: clientKey?.username, err });
    });
    client.on('authentication', (ctx) => {
      this.Logger.debug({ username: ctx.username, msg: 'Attempting authentication' });
      clientKey = this.ClientKeys.find((k) => k.username === ctx.username);
      this.authHandler(ctx, clientKey);
    });
    client.on('ready', () => {
      this.Logger.info({ username: clientKey.username, msg: 'Authenticated successfully' });
      this.Logger.onLogin({ username: clientKey.username });
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (accept) => {
          this.Logger.debug({ username: clientKey.username, msg: 'User began SFTP session' });
          const sftpStream = accept();
          new SFTPSession({
            S3Client: this.S3Client,
            S3Bucket: this.S3Bucket,
            SFTPStream: sftpStream,
            ClientKey: clientKey,
            LogFunction: this.LogFunction,
            Callbacks: this.Callbacks
          });
        }).on('close', () => {
          this.Logger.debug({ username: clientKey.username, msg: 'Session closed' });
          client.end();
        }).on('end', () => {
          this.Logger.debug({ username: clientKey.username, msg: 'Session ended' });
          client.end();
        });
      });
    });
    client.on('end', () => {
      this.Logger.info({ username: clientKey?.username, msg: 'Connection ended' });
      this.Logger.onDisconnect({ username: clientKey?.username });
    });
  }
  public listen(port: number, hostname: string, cb?: () => void) {
    this.SSHServer = new Server({
      // debug: (message) => {
      //   this.Logger.debug({ msg: message });
      // },
      hostKeys: this.HostKeys
    }, (client) => this.connectionListener(client));

    this.SSHServer.listen(port, hostname, () => {
      this.Logger.info({ msg: `Listening on port ${port}` });
      cb?.();
    });
  }
}
