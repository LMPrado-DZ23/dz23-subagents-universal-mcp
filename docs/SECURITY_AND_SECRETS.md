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

## Categorias de custo

| Tier | Providers | Sem `DZ23_ALLOW_PAID=true` |
| --- | --- | --- |
| `local` | `custom`, `lmstudio`, `vllm` em loopback ou rede privada | permitido |
| `free-tier` | `groq`, `cerebras`, `sambanova`, `nvidia`, `github`, `huggingface`, `cloudflare` | permitido |
| `mixed` | `openrouter`, `gemini`, `mistral`, `together`, `fireworks`, `novita`, `upstage`, `ollama` (cloud), `hyperbolic`, `alibaba`; adapters locais apontados para host público | bloqueado (`mixed_not_allowed`), exceto modelo terminado em `:free` ou `provider:modelo` exato em `DZ23_FREE_MODELS` |
| `low-cost` | `deepseek` | bloqueado (`paid_not_allowed`) |
| `paid` | `openai`, `anthropic`, `xai`, `perplexity` | bloqueado (`paid_not_allowed`) |

Providers `mixed` cobram alguns modelos e outros não, e a categoria é por provider: um alvo `mixed`
pode gerar cobrança. `DZ23_FREE_MODELS` (lista separada por vírgula, por exemplo
`ollama:gpt-oss:120b,openrouter:vendor/modelo`) é uma declaração do operador; inclua só modelos
realmente gratuitos na sua conta. Nenhum tier certifica gratuidade: cotas e cobranças dependem do
plano. `doctor` mostra cada alvo como `eligible` ou `skipped(motivo)` e avisa em `cost_policy`.

## Credenciais genéricas e variáveis de outros programas

- `GITHUB_TOKEN`, `HF_TOKEN` e `CLOUDFLARE_AUTH_TOKEN` costumam existir para outros fins (Git, CLIs).
  Eles só habilitam `github`, `huggingface` e `cloudflare` quando `DZ23_ROTATION` cita o provider ou
  com `DZ23_ALLOW_GENERIC_CREDENTIALS=true`. Use os nomes específicos `GITHUB_MODELS_TOKEN`,
  `HUGGINGFACE_TOKEN` e `CLOUDFLARE_API_TOKEN`. Quando ignorados, `provider_inventory`
  (`ignored_credential_source`, por exemplo `env:GITHUB_TOKEN`) e `doctor` (`generic_credentials`)
  mostram apenas o nome da variável.
- `OPENAI_BASE_URL`, `OPENAI_MODEL`, `ANTHROPIC_BASE_URL` e `ANTHROPIC_MODEL` são ignorados, porque
  SDKs, gateways e o próprio Claude Code os usam; um valor herdado redirecionaria chaves e prompts.
  Use `DZ23_OPENAI_BASE_URL`, `DZ23_OPENAI_MODEL`, `DZ23_ANTHROPIC_BASE_URL` e `DZ23_ANTHROPIC_MODEL`.
  Nos demais providers, `DZ23_<PROVIDER>_BASE_URL`/`_MODEL` têm precedência sobre os nomes sem prefixo.

## Transporte

- Base URLs de provider devem ser HTTP(S) sem usuário/senha, query ou fragmento. `http://` só é
  aceito para loopback ou rede privada; qualquer outro host exige `https://` (a configuração é
  recusada), para que chaves e prompts não trafeguem em texto claro.
- `--http` exige token (ou tokens com escopo) mesmo em loopback e recusa iniciar sem ele (código 78).
  `DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true` libera apenas loopback sem token, para teste local:
  qualquer processo ou página no mesmo computador que alcance a porta pode então chamar ferramentas
  faturáveis. `doctor` avisa quando essa opção está ativa.
- `DZ23_SHARED_COOLDOWNS=true` (padrão) grava cooldowns de provider em `<estado>/providers/status.json`
  para os processos que compartilham o diretório. Proteja o diretório de estado como o restante da
  memória; quem pode escrever nele pode tirar alvos de rotação temporariamente.

## Outros cuidados

- `ALIBABA_API_KEY`/`ALIBABA_BASE_URL` são separados de OpenAI. Together aceita
  `TogetherAIAPI_KEY`.
- A redação de logs não é um filtro universal de PII: prompts do usuário e respostas de modelos
  podem conter dados sensíveis na memória de missão, que precisa ser protegida pelo operador.
- O scanner de publicação verifica padrões conhecidos e a allowlist; não prova ausência de todo
  segredo possível. `npm run check:public` confirma que só arquivos auditados estão rastreados.
- O guard de publicação também recusa nomes como `credentials*.json`, `secrets*.json` e `token*.txt`.
