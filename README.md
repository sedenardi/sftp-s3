# sftp-s3
S3-backed SFTP server.


### Implemented SFTP Commands

- connect
- exit
- ls
- cd
- get
- put

TODO
- commands
  - rm
  - rename
  - rmdir
  - mkdir
- abstract attrs `mode`
- cleanup log levels
  - add `.emit` -> `info` logs

BUG: RMDIR directory removes objects that start with dir name
  - object: 'test1234.csv', dir: 'te'