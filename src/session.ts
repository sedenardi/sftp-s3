import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, PutObjectCommandInput, S3Client, _Object } from '@aws-sdk/client-s3';
import { PassThrough, Readable } from 'stream';
import { posix } from 'path';
const { join, normalize, basename } = posix;
import { ClientKey } from '.';
import Logger, { LogArgs, LogFunction } from './logger';
import moment from 'moment';
import constants from 'constants';
import { FileEntry, SFTPWrapper, utils } from 'ssh2';
import { Upload } from '@aws-sdk/lib-storage';

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

type OpenFile = {
  flags: number;
  fileName: string;
  fullPath: string;
  size?: number;
  stream?: PassThrough;
  reqid?: number;
  fnum?: number;
  read?: boolean;
};
type CustomS3Object = _Object & {
  IsDir?: boolean;
};
type OpenDir = {
  fullPath: string;
  listings: CustomS3Object[];
  read?: boolean;
};
export default class SFTPSession {
  protected S3Client: S3Client;
  protected S3Bucket: string;
  protected SFTPStream: SFTPWrapper;
  protected ClientKey: ClientKey;
  protected Logger: Logger;

  protected HandleCount: number;
  protected OpenFiles: Map<number, OpenFile>;
  protected OpenDirs: Map<number, OpenDir>;
  constructor(opts: {
    S3Client: S3Client,
    S3Bucket: string,
    SFTPStream: SFTPWrapper,
    ClientKey: ClientKey,
    LogFunction?: LogFunction
  }) {
    this.S3Client = opts.S3Client;
    this.S3Bucket = opts.S3Bucket;
    this.SFTPStream = opts.SFTPStream;
    this.ClientKey = opts.ClientKey;
    this.Logger = new Logger(opts.LogFunction, opts.ClientKey.username);

    this.HandleCount = 0;
    this.OpenFiles = new Map();
    this.OpenDirs = new Map();

    this.SFTPStream.on('OPEN', (reqid, filename, flags) => this.onOPEN(reqid, filename, flags));
    this.SFTPStream.on('READ', (reqid, handle, offset, length) => this.onREAD(reqid, handle, offset, length));
    this.SFTPStream.on('WRITE', (reqid, handle, offset, data) => this.onWRITE(reqid, handle, offset, data));
    this.SFTPStream.on('OPENDIR', (reqid, path) => this.onOPENDIR(reqid, path));
    this.SFTPStream.on('READDIR', (reqid, handle) => this.onREADDIR(reqid, handle));
    this.SFTPStream.on('REALPATH', (reqid, path) => this.onREALPATH(reqid, path));
    this.SFTPStream.on('CLOSE', (reqid, handle) => this.onCLOSE(reqid, handle));
    // this.SFTPStream.on('REMOVE', this.onREMOVE);
    this.SFTPStream.on('RMDIR', (reqid, path) => this.onRMDIR(reqid, path));
    this.SFTPStream.on('MKDIR', (reqid, path) => this.onMKDIR(reqid, path));
    // this.SFTPStream.on('RENAME', this.onRENAME);
    this.SFTPStream.on('STAT', (reqid, path) => this.onSTAT(reqid, path, 'STAT'));
    this.SFTPStream.on('LSTAT', (reqid, path) => this.onSTAT(reqid, path, 'LSTAT'));
  }
  protected async openRead(reqid: number, filename: string, flags: number, fullPath: string) {
    try {
      const data = await this.s3ListObjects(fullPath);
      
      const foundFile = data.Contents?.find((c) => c.Key === fullPath);
      if (!foundFile) {
        this.debug('OPEN', `no object found with key ${fullPath}`);
        return this.SFTPStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);  
      }

      const handle = Buffer.alloc(4);
      this.debug('OPEN', 'issuing handle', { handle: this.HandleCount });
      this.OpenFiles.set(this.HandleCount, {
        flags: flags,
        fileName: filename,
        size: foundFile.Size,
        fullPath: fullPath
      });
      handle.writeUInt32BE(this.HandleCount++, 0);
      return this.SFTPStream.handle(reqid, handle);
    } catch(err) {
      this.error('OPEN', err, 'error listing objects');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected async openWrite(reqid: number, filename: string, flags: number, fullPath: string) {
    try {
      const handle = Buffer.alloc(4);
      this.debug('OPEN', 'issuing handle', { handle: this.HandleCount });
      
      const stream = new PassThrough();
      this.OpenFiles.set(this.HandleCount, {
        flags: flags,
        fileName: filename,
        stream: stream,
        fullPath: fullPath
      });
      const state = this.OpenFiles.get(this.HandleCount);
      handle.writeUInt32BE(this.HandleCount++, 0);
      this.SFTPStream.handle(reqid, handle);

      this.debug('OPEN', 'starting upload');
      await this.s3UploadObject(fullPath, stream);
      this.debug('OPEN', 'finished upload');
      this.OpenFiles.delete(state.fnum);
      
      return this.SFTPStream.status(state.reqid, STATUS_CODE.OK);
    } catch(err) {
      this.error('OPEN', err, 'error uploading object');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected async onOPEN(reqid: number, filename: string, flags: number) {
    this.debug('OPEN', null, { filename, flags, handleCount: this.HandleCount });
    if(filename.endsWith('\\') || filename.endsWith('/')) {
      filename = filename.substring(0, filename.length - 1);
    }
    const fullPath = this.getFullPath(filename);

    if (flags & OPEN_MODE.READ) {
      return await this.openRead(reqid, filename, flags, fullPath);
    } else if (flags & OPEN_MODE.WRITE) {
      return await this.openWrite(reqid, filename, flags, fullPath);
    } else {
      this.debug('OPEN', 'Unsupported operation');
      return this.SFTPStream.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
    }
  }
  protected async onREAD(reqid: number, handle: Buffer, offset: number, length: number) {
    if (handle.length !== 4) {
      this.debug('READ', 'wrong handle length');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    const handleId = handle.readUInt32BE(0);
    this.debug('READ', null, { handleId, offset, length });

    const state = this.OpenFiles.get(handleId);
    if (!state || !(state.flags & OPEN_MODE.READ)) {
      this.debug('READ', 'invalid flags');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    if (state.read) {
      this.debug('READ', 'EOF');
      return this.SFTPStream.status(reqid, STATUS_CODE.EOF);
    }

    if (offset + length > state.size) {
      length = state.size - offset;
    }

    if (offset >= state.size || length === 0) {
      this.debug('READ', 'Invalid offset');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    if (offset + length >= state.size) {
      state.read = true;
    }

    try {
      const range = `bytes=${offset}-${offset + length - 1}`;
      const data = await this.s3GetObject(state.fullPath, range);
      if (data.length === 0) {
        this.error('READ', null, 'found object is empty');
        return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);  
      }
      this.debug('READ', 'successfully read file');
      return this.SFTPStream.data(reqid, data);
    } catch(err) {
      this.error('READ', err, 'error getting object');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected onWRITE(reqid: number, handle: Buffer, offset: number, data: Buffer) {
    if (handle.length !== 4) {
      this.debug('WRITE', 'wrong handle length');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    const handleId = handle.readUInt32BE(0);
    this.debug('WRITE', null, { handleId, offset });

    const state = this.OpenFiles.get(handleId);
    if (!state || !(state.flags & OPEN_MODE.WRITE)) {
      this.debug('WRITE', 'invalid flags');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    const writeData = Buffer.from(data);
    state.stream.write(writeData, (err) => {
      if (err) {
        this.error('WRITE', err, 'Error writing to stream');
        return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
      }
      this.debug('WRITE', `Wrote ${writeData.length} bytes to stream`);
      this.SFTPStream.status(reqid, STATUS_CODE.OK);
    });
  }
  protected async onOPENDIR(reqid: number, path: string) {
    this.debug('OPENDIR', null, { path });
    const fullPath = this.getFullPath(path);
    const isRoot = path === '/';
    let searchPath = fullPath;
    if (!isRoot) {
      searchPath = searchPath + '/';
    }
    try {
      this.debug('OPENDIR', 'listing objects', { fullPath });
      const data = await this.s3ListObjects(searchPath);
      this.debug('OPENDIR', `${data.Contents?.length || 0} objects found`);

      if (!data.Contents?.length && !isRoot) {
        this.debug('OPENDIR', `no object found with key ${fullPath}`);
        return this.SFTPStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      }

      const handle = Buffer.alloc(4);
      const listings: CustomS3Object[] = data.Contents.map((c) => {
        this.debug('OPENDIR', 'object found', { key: c.Key });
        let fileName = c.Key.substring(fullPath.length);
        if (!fileName.startsWith('/')) {
          fileName = '/' + fileName;
        }
        if (fileName === './.dir') {
          return null;
        }
        const parts = fileName.split('/');
        // `parts[0]` may always be an empty string since we ensure it starts with '/'
        if (parts[0]) {
          return null;
        }
        if (parts.length === 3 && parts[2] === '.dir') {
          if (!parts[1]) {
            return null;
          }
          return {
            ...c,
            Key: c.Key.replace('.dir', ''),
            IsDir: true
          };
        }
        return parts.length === 2 ? c : null;
      }).filter((c) => c);
      this.debug('OPENDIR', 'issuing handle', { handle: this.HandleCount });
      this.OpenDirs.set(this.HandleCount, { fullPath: fullPath, listings: listings });
      handle.writeUInt32BE(this.HandleCount++, 0);
      return this.SFTPStream.handle(reqid, handle);
    } catch(err) {
      this.error('OPENDIR', err, 'error listing objects');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected onREADDIR(reqid: number, handle: Buffer) {
    if (handle.length !== 4) {
      this.info('READDIR', 'invalid handle length');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    const handleId = handle.readUInt32BE(0);
    this.debug('READDIR', 'requested handle', { handle: handleId });
    
    const dirState = this.OpenDirs.get(handleId);
    if (!dirState) {
      this.info('READDIR', 'unknown handle', { handle: handleId });
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
    if (dirState.read) {
      this.debug('READDIR', 'EOF', { handle: handleId });
      return this.SFTPStream.status(reqid, STATUS_CODE.EOF);
    }

    dirState.read = true;
    const entries: FileEntry[] = dirState.listings.map((l) => {
      let fileName = l.Key.substring(dirState.fullPath.length);
      if (fileName.startsWith('/')) {
        fileName = fileName.substring(1);
      }
      if (fileName.endsWith('/')) {
        fileName = fileName.substring(0, fileName.length - 1);
      }

      let mode = 0;
      mode |= constants.S_IRWXU; // read, write, execute for user
      mode |= constants.S_IRWXG; // read, write, execute for group
      mode |= constants.S_IRWXO; // read, write, execute for other
      if (l.IsDir) {
        mode |= constants.S_IFDIR;
      } else {
        mode |= constants.S_IFREG;
      }

      const attrs = {
        mode: mode,
        uid: 0,
        gid: 0,
        size: (l.IsDir ? 1 : l.Size),
        atime: l.LastModified.valueOf(),
        mtime: l.LastModified.valueOf()
      };
      return {
        filename: fileName,
        longname: this.getLongname(l, fileName),
        attrs
      };
    });
    this.debug('READDIR', `returning ${entries.length} entries`);
    return this.SFTPStream.name(reqid, entries);
  }
  protected async onREALPATH(reqid: number, path: string) {
    this.debug('REALPATH', null, { path });
    let requestedPath = path;
    if (requestedPath === '.') {
      requestedPath = '/';
    }
    let normalizedPath = normalize(requestedPath);
    if (!normalizedPath.startsWith('/')) {
      normalizedPath = '/' + normalizedPath;
    }
    const fullPath = this.getFullPath(requestedPath);
    this.debug('REALPATH', 'listing objects', { fullPath, normalizedPath });

    try {
      const data = await this.s3ListObjects(fullPath);
      this.debug('REALPATH', `${data.Contents?.length || 0} objects found`);
      
      let realObj = data.Contents?.find((c) => {
        return (
          c.Key === fullPath ||
          c.Key === (fullPath + '/.dir')
        );
      }) as CustomS3Object;
      
      if (realObj?.Key.endsWith('.dir')) {
        this.debug('REALPATH', `${realObj.Key} is a directory`);
        realObj.IsDir = true;
      }
      if (!realObj) {
        if (normalizedPath === '/' || normalizedPath === '/.') {
          this.debug('REALPATH', 'listing root directory');
          realObj = {
            IsDir: true,
            LastModified: new Date(),
            Size: 0
          };
        } else {
          this.debug('REALPATH', 'no objects found', { fullPath });
          return this.SFTPStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        }
      }

      this.debug('REALPATH', 'returning real name');
      return this.SFTPStream.name(reqid, [{
        filename: normalizedPath,
        longname: this.getLongname(realObj, normalizedPath),
        attrs: null // TODO: may need to set to directory attrs
      }]);
    } catch(err) {
      this.error('REALPATH', err, 'error listing objects');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected onCLOSE(reqid: number, handle: Buffer) {
    if (handle.length !== 4) {
      this.info('CLOSE', 'invalid handle length');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    const handleId = handle.readUInt32BE(0);
    this.debug('CLOSE', null, { handle: handleId });
    
    if (!this.OpenFiles.has(handleId) && !this.OpenDirs.has(handleId)) {
      this.info('CLOSE', 'unknown handle', { handle: handleId });
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    if (this.OpenFiles.has(handleId)) {
      const fileState = this.OpenFiles.get(handleId);
      if (fileState.flags & OPEN_MODE.WRITE) {
        fileState.reqid = reqid;
        fileState.fnum = handleId;
        fileState.stream.end();
        this.debug('CLOSE', 'stream closed', { handle: handleId });
        return;
      } else {
        this.debug('CLOSE', 'file downloaded, removing file handle', { fileName: fileState.fileName });
        this.OpenFiles.delete(handleId);
      }
    } else {
      this.debug('CLOSE', 'removing dir handle');
      this.OpenDirs.delete(handleId);
    }
    return this.SFTPStream.status(reqid, STATUS_CODE.OK);
  }
  // protected onREMOVE(reqid: number, path: string) {
  //   this.debug('REMOVE');
  // }
  protected async onRMDIR(reqid: number, path: string) {
    this.debug('RMDIR', null, { path });

    const fullPath = this.getFullPath(path);
    const searchPath = fullPath + '/';
    const dirFilePath = join(fullPath, '.dir');

    let contents: _Object[];

    try {
      this.debug('RMDIR', 'listing objects');
      const data = await this.s3ListObjects(searchPath);
      this.debug('RMDIR', `listed ${data.Contents?.length || 0} objects successfully`);
      contents = data.Contents || [];
    } catch(err) {
      this.error('RMDIR', err, 'error listing objects');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }

    if (!contents.length) {
      this.error('RMDIR', null, 'directory not found');
      return this.SFTPStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }

    const dirNotEmpty = contents.some((c) => c.Key !== dirFilePath);
    if (dirNotEmpty) {
      this.error('RMDIR', null, 'directory not empty');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE, 'Directory not empty');
    }

    try {
      this.debug('RMDIR', 'deleting object');
      await this.s3DeleteObject(dirFilePath);
      this.debug('RMDIR', 'deleted object successfully');
      return this.SFTPStream.status(reqid, STATUS_CODE.OK);
    } catch(err) {
      this.error('RMDIR', err, 'error deleting objects');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected async onMKDIR(reqid: number, path: string) {
    this.debug('MKDIR', null, { path });

    let dirFilePath = join(path, '.dir');
    if (dirFilePath.endsWith('/')) {
      dirFilePath = dirFilePath.slice(0, -1);
    }
    const fullPath = this.getFullPath(dirFilePath);

    try {
      this.debug('MKDIR', 'uploading object');
      await this.s3PutObject(fullPath, '', 0);
      this.debug('MKDIR', 'uploaded object successfully');
      return this.SFTPStream.status(reqid, STATUS_CODE.OK);
    } catch(err) {
      this.error('MKDIR', err, 'error uploading object');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  // protected onRENAME(reqid: number, oldPath: string, newPath: string) {
  //   this.debug('RENAME');
  // }
  protected async onSTAT(reqid: number, path: string, event: 'STAT' | 'LSTAT') {
    this.debug(event, null, { path });
    const fullPath = this.getFullPath(path);
    try {
      this.debug(event, 'listing objects', { fullPath });
      const data = await this.s3ListObjects(fullPath);

      const exactMatch = data.Contents?.find((c) => c.Key === fullPath);
      if (exactMatch) {
        this.debug(event, 'Retrieved file attrs');
        let mode = constants.S_IFREG;   // regular file
        mode |= constants.S_IRWXU;      // read, write, execute for user
        mode |= constants.S_IRWXG;      // read, write, execute for group
        mode |= constants.S_IRWXO;      // read, write, execute for other
        return this.SFTPStream.attrs(reqid, {
          mode: mode,
          uid: 0,
          gid: 0,
          size: exactMatch.Size,
          atime: exactMatch.LastModified.valueOf(),
          mtime: exactMatch.LastModified.valueOf()
        });
      }

      const directoryMatch = data.Contents?.find((c) => c.Key === (fullPath + '/.dir'));
      const isRoot = path === '/';
      if (directoryMatch || isRoot) {
        let mode = constants.S_IFDIR;   // directory
        mode |= constants.S_IRWXU;      // read, write, execute for user
        mode |= constants.S_IRWXG;      // read, write, execute for group
        mode |= constants.S_IRWXO;      // read, write, execute for other

        this.debug(event, 'Retrieved directory attrs');
        return this.SFTPStream.attrs(reqid, {
          mode: mode,
          uid: 0,
          gid: 0,
          size: 1,
          atime: isRoot ? Date.now() : directoryMatch.LastModified.valueOf(),
          mtime: isRoot ? Date.now() : directoryMatch.LastModified.valueOf()
        });
      }

      this.debug(event, 'Key not found');
      return this.SFTPStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    } catch(err) {
      this.error(event, err, 'error listing objects');
      return this.SFTPStream.status(reqid, STATUS_CODE.FAILURE);
    }
  }
  protected getLongname(object: CustomS3Object, normalizedPath: string) {
    const momentObj = moment(object.LastModified);
    const nameParts = [
      `${object.IsDir ? 'd' : '-'}rw-rw-rw-`,
      '1',
      this.ClientKey.username,
      this.ClientKey.username,
      object.Size.toString(),
      momentObj.format('MMM D'),
      momentObj.year() === moment().year() ? momentObj.format('HH:mm') : momentObj.format('YYYY'),
      basename(normalizedPath) || normalizedPath
    ];
    return nameParts.join(' ');
  }
  protected s3ListObjects(prefix: string) {
    const command = new ListObjectsV2Command({ Bucket: this.S3Bucket, Prefix: prefix });
    return this.S3Client.send(command);
  }
  protected async s3GetObject(key: string, range: string) {
    const command = new GetObjectCommand({
      Bucket: this.S3Bucket,
      Key: key,
      Range: range
    });
    const data = await this.S3Client.send(command);
    const stream = data.Body as Readable;
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  protected s3UploadObject(key: string, stream: PassThrough) {
    const upload = new Upload({
      client: this.S3Client,
      params: {
        Bucket: this.S3Bucket,
        Key: key,
        Body: stream
      },
    });
    return upload.done();
  }
  protected s3PutObject(key: string, body: PutObjectCommandInput['Body'], contentLength?: number) {
    const command = new PutObjectCommand({
      Bucket: this.S3Bucket,
      Key: key,
      Body: body,
      ContentLength: contentLength
    });
    return this.S3Client.send(command);
  }
  protected s3DeleteObject(key: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.S3Bucket,
      Key: key
    });
    return this.S3Client.send(command);
  }
  protected getFullPath(filename: string) {
    const fullPath = join(this.ClientKey.path, normalize(filename));
    return fullPath;
  }
  protected getLogMsg(event: string, msg?: string) {
    let logStr = event;
    if (msg) {
      logStr += ` - ${msg}`;
    }
    return logStr;
  }
  protected debug(event: string, msg?: string, args?: LogArgs) {
    this.Logger.debug({ msg: this.getLogMsg(event, msg), args });
  }
  protected info(event: string, msg?: string, args?: LogArgs) {
    this.Logger.info({ msg: this.getLogMsg(event, msg), args });
  }
  protected error(event: string, err: Error, msg?: string, args?: LogArgs) {
    this.Logger.error({ msg: this.getLogMsg(event, msg), args, err });
  }
}
