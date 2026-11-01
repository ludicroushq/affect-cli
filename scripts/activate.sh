affect_exports=$(bun "${BASH_SOURCE[0]%/*}/../dist/index.js" env) || exit 1
eval "$affect_exports"
unset affect_exports
