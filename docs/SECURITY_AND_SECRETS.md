# Configuração privada e segredos

Leia [SECURITY.md](../SECURITY.md). Não guarde credenciais em repositórios, prompts,
exemplos, relatórios ou memória de projetos. O pacote público contém só `.env.example`.

## Onde ficam os segredos

- O runtime lê o `.env` da pasta de instalação sem sobrescrever variáveis já existentes.
- Providers aceitam `<NOME>_FILE` para ler a chave de um arquivo montado. Arquivo configurado
  e ilegível interrompe a inicialização.
- Token HTTP: `DZ23_MCP_TOKEN` **ou** `DZ23_MCP_TOKEN_FILE`. Definir os dois impede a
  inicialização, para que a rotação do arquivo nunca seja sombreada. Espaços e quebras de linha
  finais do arquivo são removidos; arquivo vazio ou ilegível falha explicitamente. Em POSIX,
  permissões acessíveis a grupo/outros geram aviso: use `chmod 600`.
- Tokens com escopo (`DZ23_AUTH_MODE=scoped`): `DZ23_MCP_TOKENS_FILE` guarda apenas o SHA-256
  de cada token, com `id` e `scopes`. Gere o digest com
  `printf %s "$TOKEN" | node src/index.js token hash`. O token primário, se configurado, continua
  com todos os escopos. Revogar um token = remover a entrada e reiniciar o processo.

Escopos: `memory:read`, `memory:write`, `delegate:execute`, `health:execute`,
`provider:discover`, `admin:inventory` (este último também libera `/metrics`).

## O que nunca sai do processo

Valores de chaves e tokens não aparecem em inventário, resultados, erros, métricas, memória ou
logs. `provider_inventory` mostra apenas a origem (`env:NOME`, `file:NOME_FILE`, `none`).
Erros de provider são classificados por status e padrões e nunca retornam o corpo recebido.
Falhas inesperadas aparecem como `internal_error`, sem mensagem interna ou caminho de arquivo.
Erros de lock não expõem `pid` nem `hostname` a clientes.

## Outros cuidados

- `ALIBABA_API_KEY`/`ALIBABA_BASE_URL` são separados de OpenAI. Together aceita
  `TogetherAIAPI_KEY`; Hugging Face aceita `HF_TOKEN`.
- Endpoints devem ser HTTP(S) sem usuário/senha, query ou fragmento.
- A redação de logs não é um filtro universal de PII: prompts do usuário e respostas de modelos
  podem conter dados sensíveis na memória de missão, que precisa ser protegida pelo operador.
- O scanner de publicação verifica padrões conhecidos e a allowlist; não prova ausência de todo
  segredo possível. `npm run check:public` confirma que só arquivos auditados estão rastreados.
- O guard de publicação também recusa nomes como `credentials*.json`, `secrets*.json` e `token*.txt`.
