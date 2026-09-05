FROM node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
COPY nub /opt/nub/bin/nub
COPY runtime /opt/nub/runtime
COPY helm /usr/local/bin/helm
ENV PATH=/opt/nub/bin:/usr/local/bin:/usr/bin:/bin
ENV HOME=/tmp/home
ENTRYPOINT []
CMD ["sleep", "infinity"]
