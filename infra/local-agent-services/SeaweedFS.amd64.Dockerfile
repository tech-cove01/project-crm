# Local x86_64 image based on the official SeaweedFS release.
FROM chrislusf/seaweedfs:3.95
WORKDIR /data
ENTRYPOINT ["/usr/bin/weed", "-logtostderr=true"]
