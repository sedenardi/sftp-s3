# sftp-s3
S3-backed SFTP server.


### Implemented SFTP Commands

- connect
- exit
- ls

TODO
- cd
  - TODO - cd /
  - TODO - cd ..
- abstract attrs `mode`
- cleanup log levels

BUG: RMDIR directory removes objects that start with dir name
  - object: 'test1234.csv', dir: 'te'