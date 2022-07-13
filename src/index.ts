import { S3Client } from '@aws-sdk/client-s3';
import { AuthContext, Connection, ParsedKey, Server, ServerConfig, utils } from 'ssh2';
import { posix } from 'path';
const { join, normalize } = posix;
import { timingSafeEqual } from 'crypto';
import Logger, { LogFunction } from './logger';
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

  protected Logger: Logger;
  protected ClientKeys: ClientKey[];
  protected SSHServer: Server;
  constructor(opts: {
    S3Client: S3Client,
    S3Bucket: string,
    HostKeys: HostKeys,
    LogFunction?: LogFunction
  }) {
    this.S3Client = opts.S3Client;
    this.S3Bucket = opts.S3Bucket;
    this.HostKeys = opts.HostKeys;
    this.LogFunction = opts.LogFunction;
    this.Logger = new Logger(opts.LogFunction);

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
  }
  protected authHandler(ctx: AuthContext, clientKey: ClientKey) {
    if (ctx.method !== 'publickey') {
      this.Logger.info({ username: ctx.username, msg: 'rejecting non-public-key authentication' });
      return ctx.reject(['publickey']);
    }
    if (!clientKey) {
      this.Logger.info({ username: ctx.username, msg: 'public key not found for user' });
      return ctx.reject(['publickey']);
    }
    const clientKeyMatch = (
      ctx.key.algo === clientKey.key.type  &&
      timingSafeEqual(ctx.key.data, Buffer.from(clientKey.key.getPublicSSH()))
    );
    if (!clientKeyMatch) {
      this.Logger.info({ username: ctx.username, msg: 'matching public key not found' });
      return ctx.reject(['publickey']);
    }
    if (ctx.signature) {
      const signatureVerified = clientKey.key.verify(ctx.blob, ctx.signature);
      if (signatureVerified) {
        this.Logger.info({ username: ctx.username, msg: 'signature verified' });
        return ctx.accept();
      } else {
        this.Logger.info({ username: ctx.username, msg: 'signature rejected' });
        return ctx.reject();
      }
    } else {
      this.Logger.info({ username: ctx.username, msg: 'no signature present' });
      return ctx.accept();
    }
  }
  protected connectionListener(client: Connection) {
    let clientKey: ClientKey = null;
    client.on('error', (err) => {
      this.Logger.error({ username: clientKey?.username, err });
    });
    client.on('authentication', (ctx) => {
      this.Logger.info({ username: ctx.username, msg: 'Attempting authentication' });
      clientKey = this.ClientKeys.find((k) => k.username === ctx.username);
      this.authHandler(ctx, clientKey);
    });
    client.on('ready', () => {
      this.Logger.info({ username: clientKey.username, msg: 'Authenticated successfully' });
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (accept) => {
          this.Logger.info({ username: clientKey.username, msg: 'User began SFTP session' });
          const sftpStream = accept();
          new SFTPSession({
            S3Client: this.S3Client,
            S3Bucket: this.S3Bucket,
            SFTPStream: sftpStream,
            ClientKey: clientKey,
            LogFunction: this.LogFunction
          });
        }).on('close', () => {
          this.Logger.info({ username: clientKey.username, msg: 'Session closed' });
          client.end();
        }).on('end', () => {
          this.Logger.info({ username: clientKey.username, msg: 'Session ended' });
          client.end();
        });
      });
    });
    client.on('end', () => {
      this.Logger.info({ username: clientKey?.username, msg: 'Connection ended' });
    });
  }
  public listen(port: number, hostname: string, cb?: () => void) {
    this.SSHServer = new Server({
      hostKeys: this.HostKeys
    }, (client) => this.connectionListener(client));

    this.SSHServer.listen(port, hostname, () => {
      this.Logger.info({ msg: `Listening on port ${port}` });
      cb?.();
    });
  }
}
