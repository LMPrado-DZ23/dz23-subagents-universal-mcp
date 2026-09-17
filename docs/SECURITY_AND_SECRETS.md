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
| `local` | `custom`, `lmstudio`, `vllm` com endpoint privado (IP de loopback/privado, `localhost`, `host.docker.internal` ou host em `DZ23_PRIVATE_HOSTS`) | permitido; modelos `:cloud`/`-cloud` contam como `mixed` |
| `free-tier` | `groq`, `cerebras`, `sambanova`, `nvidia`, `github`, `huggingface`, `cloudflare` | permitido (pode cobrar acima da cota grátis da conta) |
| `mixed` | `openrouter`, `gemini`, `mistral`, `together`, `fireworks`, `novita`, `upstage`, `ollama` (cloud), `hyperbolic`, `alibaba`; adapters locais apontados para host público | bloqueado (`mixed_not_allowed`), exceto `provider:modelo` exato em `DZ23_FREE_MODELS` ou modelo `:free` do OpenRouter |
| `low-cost` | `deepseek` | bloqueado (`paid_not_allowed`) |
| `paid` | `openai`, `anthropic`, `xai`, `perplexity` | bloqueado (`paid_not_allowed`) |

Providers `mixed` cobram alguns modelos e outros não, e a categoria é por provider: um alvo `mixed`
pode gerar cobrança. `DZ23_FREE_MODELS` (lista separada por vírgula, por exemplo
`ollama:glm-5.3-flash,mistral:mistral-small-latest`) é uma declaração do operador; inclua só modelos
realmente gratuitos na sua conta. O sufixo `:free` só significa gratuito no OpenRouter; em outros
providers ou gateways é um nome qualquer e não libera nada. Nenhum tier certifica gratuidade: `free-tier`
também cobra acima da cota em muitos planos (Hugging Face, Cloudflare, Groq, Cerebras, GitHub Models).
Um gateway local (LiteLLM, OmniRoute) que repassa para nuvens pagas continua `local`: coloque na rotação
só os modelos que você aceita pagar. `doctor` mostra cada alvo como `eligible` ou `skipped(motivo)` e
avisa em `cost_policy`.

Chamadas canceladas ou com timeout depois de enviadas ao provider entram no orçamento pela reserva
(`token_source: "reserved_estimate"`), porque o provider pode ter gerado e cobrado a resposta.

## Credenciais genéricas e variáveis de outros programas

- `GITHUB_TOKEN`, `HF_TOKEN`, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_AUTH_TOKEN` costumam existir para
  outros fins (Git, wrangler, CLIs). Eles só habilitam `github`, `huggingface` e `cloudflare` quando
  `DZ23_ROTATION` cita o provider ou com `DZ23_ALLOW_GENERIC_CREDENTIALS=true`. Use os nomes específicos
  `GITHUB_MODELS_TOKEN`, `HUGGINGFACE_TOKEN` e `CLOUDFLARE_WORKERS_AI_TOKEN`. Quando ignorados,
  `provider_inventory` (`ignored_credential_source`, por exemplo `env:GITHUB_TOKEN`), `providers` (coluna
  `NOTE`) e `doctor` (`generic_credentials`) mostram apenas o nome da variável.
- Provedores de nuvem só leem endpoint e modelo com prefixo: `DZ23_<PROVIDER>_BASE_URL` e
  `DZ23_<PROVIDER>_MODEL`. Nomes sem prefixo como `OPENAI_BASE_URL`, `ANTHROPIC_MODEL`,
  `OLLAMA_BASE_URL` ou `GROQ_MODEL` são ignorados, porque SDKs, gateways e o próprio Claude Code os usam;
  um valor herdado redirecionaria chaves e prompts. Os adapters locais (`custom`, `lmstudio`, `vllm`)
  mantêm `CUSTOM_BASE_URL`, `LMSTUDIO_BASE_URL`, `VLLM_BASE_URL` e `*_MODEL`.

## Transporte

- Base URLs de provider devem ser HTTP(S) sem usuário/senha, query ou fragmento. `http://` só é
  aceito para endpoint privado: IP de loopback ou privado, `localhost`, `host.docker.internal` ou host
  listado em `DZ23_PRIVATE_HOSTS`. Nomes sem ponto e `.local` não contam sozinhos, porque no Windows
  são resolvidos por LLMNR, NetBIOS ou mDNS e qualquer máquina da rede pode responder. Qualquer outro
  host exige `https://` (a configuração é recusada), para que chaves e prompts não trafeguem em texto claro.
- `--http` exige token (ou tokens com escopo) mesmo em loopback e recusa iniciar sem ele (código 78).
  `DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true` libera apenas loopback sem token, para teste local:
  qualquer processo ou página no mesmo computador que alcance a porta pode então chamar ferramentas
  faturáveis. `doctor` avisa quando essa opção está ativa.
- `DZ23_SHARED_COOLDOWNS=true` (padrão) grava cooldowns transitórios (rate limit, quota,
  indisponibilidade, timeout) em `<estado>/providers/status.json` para os processos que compartilham o
  diretório. Falhas de autenticação, permissão, cobrança ou modelo ficam no processo, porque cada
  harness tem o próprio ambiente. `Retry-After` e cooldowns lidos do arquivo são limitados a 1 hora.
  Proteja o diretório de estado como o restante da memória; quem pode escrever nele pode tirar alvos
  de rotação por até uma hora.

## Leitura de projeto, Git e dados pessoais (4.1.0)

- `workspace_read`, `workspace_search`, `git_readonly` e `context` só existem com `DZ23_WORKSPACE_ROOTS`.
  Arquivos de credencial conhecidos (`.env*`, `.npmrc`, `.git-credentials`, `.netrc`, chaves SSH e PEM,
  `*.pfx`, `.aws`, `.kube`...) nunca são lidos, listados ou buscados, e segredos com formato conhecido são
  mascarados em tudo o que essas ferramentas devolvem ou anexam ao prompt.
- A configuração local de um repositório é tratada como não confiável: o Git roda sem pager, fsmonitor, hooks,
  diff externo e textconv, com ambiente mínimo (sem as chaves do processo), e recusa repositórios cuja
  configuração executa programas (`git_config_unsafe`).
- `privacy: auto` mascara CPF/CNPJ/cartão válidos, e-mail e telefone formatado antes de enviar contexto; é uma
  heurística, não um DLP. Para material sensível use `privacy: local_only`, que só roteia para modelos locais.
- Travas de missão coordenam harnesses que cooperam; não são controle de acesso. O log de auditoria detecta
  edição de linhas, mas quem controla o diretório de estado pode reescrevê-lo por inteiro.

## Provedores de conta (4.3.0)

- O servidor **não faz login**: nunca digita usuário, senha ou token, não abre página de login e não lê os
  arquivos de credencial das CLIs para extrair token. O login é feito por você, uma vez, na CLI oficial.
  Automatizar login de site com a sua senha violaria os termos dos provedores e não está implementado.
- Uma CLI só é usada quando o status dela indica conta/assinatura. Login por chave de API é recusado
  (`authentication_failed`), senão um "provedor de conta" poderia cobrar por token sem você perceber.
  **Não existe fallback automático de conta para API**: isso é decisão da rotação.
- O processo filho recebe ambiente reduzido: qualquer variável com cara de credencial (`*API_KEY*`, `*TOKEN*`,
  `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`) e os prefixos de provedor/nuvem (`ANTHROPIC_`,
  `OPENAI_`, `GOOGLE_API`, `GOOGLE_GENAI`, `VERTEX`, `DASHSCOPE_`, `OPENROUTER_`, `AWS_`, `AZURE_`,
  `CLAUDE_CODE_`, `DZ23_`) são removidos. Consequência prática: quem autentica o Claude Code por
  `CLAUDE_CODE_OAUTH_TOKEN` precisa também do login de conta na CLI.
- A CLI roda numa pasta temporária vazia, com ferramentas e servidores MCP desligados por flag e sem persistir
  sessão, para não ler o seu repositório nem executar comandos por conta própria. Isso depende das flags da
  CLI: trate uma CLI de terceiro como código em que você já confia nesta máquina.
- O id do modelo entra na linha de comando da CLI, então ele é validado antes: precisa começar com letra ou
  dígito e usar só letras, dígitos e `. _ - / @ :`. Assim um pedido como `codex-cli:--flag` não vira opção.
- O executável é procurado em `DZ23_CLI_<NOME>_PATH`, nos caminhos oficiais de instalação e no `PATH`. Quem
  puder escrever numa pasta do seu `PATH` (ou na pasta de instalação da CLI) escolhe o binário que o servidor
  executa — o mesmo risco que já existe para você no terminal. Com `DZ23_CLI_<NOME>_PATH` você fixa o caminho.
- O status de login fica em cache por 5 minutos: um logout feito agora pode ser percebido só depois disso, e a
  chamada seguinte falha com erro de autenticação (nunca cai para API paga).
- `account_status` e o `doctor` mostram só instalado/logado/método/comando de login. Nenhum valor de
  credencial entra em log, erro ou memória de missão: o texto de erro da CLI é usado apenas para classificar a
  falha, e o detalhe enviado ao cliente é uma frase fixa com o código de saída.
- O gateway OmniRoute é um provider HTTP comum apontado para `127.0.0.1`: a chave vem de
  `OMNIROUTE_API_KEY_FILE` (recomendado) ou da variável, e quem controla o gateway controla o destino final
  das mensagens.

## Painel e sandbox de patch (4.2.0)

- O painel escuta só em `127.0.0.1`, recusa `Host` diferente de loopback, exige o token aleatório da execução
  (comparação em tempo constante), só responde `GET` e não mostra chaves nem tokens de trava.
- `patch_validate` fica desligado por padrão. O cliente não escolhe comandos: só um dos definidos pelo operador em
  `DZ23_SANDBOX_COMMANDS`, por igualdade exata. O diff é aplicado num clone temporário; caminhos protegidos,
  absolutos, `..` e `.git` são recusados antes de copiar. O comando recebe ambiente mínimo, sem as chaves de
  provedor do servidor. O diff é código escrito pelo cliente e o comando de teste o executa: por isso o padrão é
  `docker` (`--network none`, limites de CPU, memória e processos), e symlinks e submódulos no diff são recusados.
  **O modo `process` (só com `DZ23_SANDBOX_MODE=process`) não tem isolamento de rede nem de sistema de arquivos**:
  o código do diff roda com o usuário do servidor.

## Outros cuidados

- `ALIBABA_API_KEY`/`DZ23_ALIBABA_BASE_URL` são separados de OpenAI. Together aceita
  `TogetherAIAPI_KEY`.
- A redação de logs não é um filtro universal de PII: prompts do usuário e respostas de modelos
  podem conter dados sensíveis na memória de missão, que precisa ser protegida pelo operador.
- O scanner de publicação verifica padrões conhecidos e a allowlist; não prova ausência de todo
  segredo possível. `npm run check:public` confirma que só arquivos auditados estão rastreados.
- O guard de publicação também recusa nomes como `credentials*.json`, `secrets*.json` e `token*.txt`.
