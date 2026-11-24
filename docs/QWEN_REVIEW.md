# Revisor independente Qwen (`scripts/qwen-review.mjs`)

Auditoria de código pelo Qwen (API cloud OpenAI-compatible) do estado atual de um repositório git.
Pensado como **segundo auditor independente** ao lado de outro revisor (ex.: Codex): a aprovação do
Qwen sozinha nunca deve liberar uma entrega.

## Uso

Dentro do repositório a auditar:

```bash
node <instalação>/scripts/qwen-review.mjs [--adversarial] [--base <ref>] [--focus "<tema>"] [--project <nome>] [--block-ignored]
```

- Sem `--base`: árvore de trabalho atual (staged, unstaged e não rastreados) contra `HEAD`.
- Com `--base <ref>`: árvore de trabalho atual contra o merge-base de `<ref>` e `HEAD`.
- `--adversarial`: revisão que assume a mudança errada até prova em contrário (segurança, dados, concorrência).

Códigos de saída: `0` aprovado · `1` bloqueante · `2` configuração/uso · `3` falha da API.

## Configuração

Mesmas variáveis do provider `alibaba` deste MCP, lidas do ambiente ou do `.env` da instalação
(`DZ23_SUBAGENTS_ENV` aponta outro arquivo). Só estas chaves são lidas do `.env`:

| Variável | Padrão |
| --- | --- |
| `ALIBABA_API_KEY` (ou `ALIBABA_API_KEY_FILE`) | — (obrigatória) |
| `DZ23_ALIBABA_BASE_URL` | o mesmo do provider `alibaba` (`src/providers.js`); só `https`, sem credenciais/query |
| `DZ23_ALIBABA_MODEL` | o mesmo do provider `alibaba` |
| `DZ23_VAULT` (opcional) | grava o parecer em `$DZ23_VAULT/60-auditorias/` |

Chaves do **Coding Plan** (`sk-sp-...`) usam outro endpoint: defina `DZ23_ALIBABA_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1`
e um modelo disponível no plano em `DZ23_ALIBABA_MODEL`. A chave nunca é impressa nem gravada.

## O que vai para a API

- Instruções fixas na mensagem `system`; diff, foco e descrição do alvo na mensagem `user`, entre
  marcas aleatórias e tratados como **dados não confiáveis**.
- Segredos são mascarados (padrões conhecidos, credenciais em URL inclusive IPv6, tokens de alta
  entropia). Depois, o payload inteiro passa pela heurística própria **e** por `secretDetected` de
  `src/redact.js`; se sobrar qualquer suspeita, a chamada é **abortada** (saída 1), inclusive em dry-run.
- Conteúdo de arquivos sensíveis (`.env*` exceto exemplos, chaves, credenciais, `*.tfvars` etc.) nunca é
  enviado, inclusive quando renomeado/copiado para outro nome.

## Fail-closed: o que bloqueia (saída 1)

- Achado `CRITICO`/`ALTO`, veredito ausente/duplicado/fora da última linha, parecer fora do formato.
- Diff truncado (> 200 KB), binário (inclusive sem byte NUL), texto não UTF-8, arquivo novo > 50 KB.
- Symlink/junction também em diretório-pai de arquivo novo (checado antes e depois da abertura).
- O dry-run (`QWEN_REVIEW_DRY_RUN=1`) já sai com 1 quando há omissão, truncamento ou indício de injection.
- Symlink, junction, hardlink, submódulo ou arquivo trocado durante a leitura.
- Arquivo sensível alterado (conteúdo não enviado).
- Texto com cara de instrução ao auditor (prompt injection) no diff ou no foco.

## Git endurecido

Toda chamada usa `core.fsmonitor=false`, `diff.external=`, `--no-ext-diff`, `--no-textconv`, anula
`clean/smudge/process` de todo filtro configurado e remove do ambiente `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, `GIT_SSH*`, `GIT_CONFIG_*` (preservando só `safe.directory`).
Um repositório não confiável não consegue executar comandos durante a coleta.

## Limites conhecidos

- Arquivos ignorados por `.gitignore`/exclude **não** são revisados e, por padrão, não bloqueiam (a nota registra
  quantos são). Use `--block-ignored` (ex.: em CI) para que qualquer caminho ignorado bloqueie a aprovação.
- Leitura de arquivo novo: resta uma janela mínima de corrida se um processo hostil concorrente trocar e
  destrocar um diretório-pai por junction entre as checagens (Windows não tem `O_NOFOLLOW`).
- O mascaramento é heurístico: reduz o risco, não prova ausência de segredo. Não use em repositórios
  com segredos reais versionados.
- Este próprio repositório contém exemplos de veredito nos testes, então revisá-lo com o Qwen sempre
  bloqueia por indício de injection; use outro revisor aqui.

## Testes

`node --test test/qwen-review.test.js` (sem rede). `QWEN_REVIEW_DRY_RUN=1` mostra o que seria enviado,
sem chamar a API nem gravar nota.
