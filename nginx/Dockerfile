FROM nginx:alpine
# Config dentro da imagem — evita bind-mount de arquivo no Coolify
# (erro "mount a directory onto a file" em /data/coolify/.../nginx/nginx.conf).
COPY nginx.conf /etc/nginx/nginx.conf
