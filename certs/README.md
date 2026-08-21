Trust anchors for outbound TLS the DLP initiates (currently: the SIEM's JWKS host).

Mounted read-only at /etc/cybersentineldlp/certs in both dev and prod.
Point SIEM_JWKS_CA_BUNDLE at a file in here, e.g.
  SIEM_JWKS_CA_BUNDLE=/etc/cybersentineldlp/certs/siem-jwks.pem

Certificates are public; they are safe to commit. Private keys are NOT, and
nothing in this directory should ever be one.
