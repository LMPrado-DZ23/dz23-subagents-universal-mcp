# Suporte

Use issues para bugs e pedidos de melhoria depois de o repositório existir.
Inclua versão, sistema, versão Node, transporte, ferramenta chamada, resultado
esperado/observado e reprodução mínima com dados sintéticos. Remova secrets e
contexto privado de logs antes de compartilhar. Segurança: SECURITY.md.

Primeiro passo: `node src/index.js doctor --json` (não chama providers, não imprime segredos).
Sem provider configurado: revise .env privado, MODEL/BASE_URL e DZ23_ROTATION.
Catálogo disponível mas inferência falha: use `verify_model` e confira entitlement, quota e modelo.
Erro 401/403 no MCP: confira token, escopos, hostname e Origin; não desabilite os controles.
Erro 429: respeite `Retry-After` ou ajuste os limites documentados em docs/OPERATIONS.md.
Lock timeout ou memory_integrity: rode `node src/index.js memory repair` e siga docs/OPERATIONS.md.

Nenhum prazo de atendimento ou garantia de integração universal é oferecido.
