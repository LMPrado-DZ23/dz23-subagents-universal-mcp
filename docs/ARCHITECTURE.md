# Arquitetura e limites de responsabilidade

## Componentes reais

`src/index.js` carrega ambiente e inicia stdio/HTTP. `mcp.js` expõe dez ferramentas;
`core.js` coordena chamadas; `providers.js` contém registro e adapters; `concurrency.js`
limita chamadas por processo; `memory.js` persiste estado, journal e checkpoints;
`http.js` implementa JSON-RPC/REST em HTTP. Não há banco remoto ou dependências npm.

A arquitetura usa um único adapter OpenAI-compatible para provedores compatíveis
e Anthropic Messages nativa para Anthropic. Credenciais ficam no processo, fora do
inventário retornado. Providers definidos não são automaticamente providers validados.

## Fluxo de trabalho

`swarm_run` envia todos os papéis primeiro ao alvo elegível prioritário; alvos
seguintes são usados somente como failover. O limiter continua controlando as chamadas
em voo por provider:model. Cada chamada lê um bundle do projeto/missão e retorna
texto. Um reviewer integra propostas ao final. Isso não implementa DAG de tarefas,
worktrees, merges, execução de patches ou testes de código produzido. A independência
das respostas do consensus também não é garantida: retries podem convergir ao mesmo provider.

`DZ23_MAX_CONCURRENCY`, `DZ23_MAX_WORKERS_PER_TARGET` e `DZ23_MAX_QUEUE` limitam
chamadas simultâneas e espera; recursos são liberados inclusive em erro. Os limites são por
processo e por par provider:model, não um limite distribuído de conta/API.

## Persistência

Estrutura: `projects/<project_id>/project.json` e
`projects/<project_id>/missions/<mission_id>/{state.json,journal.jsonl,checkpoints/}`.
IDs devem começar com letra/número e usar 1–120 letras, números, `.`, `_` ou `-`.
Não se normalizam silenciosamente IDs diferentes para o mesmo caminho.

Writes JSON usam arquivo temporário + rename; mutações usam diretório lock por
projeto. Arquivos novos usam modo 0600 e diretórios novos 0700 em sistemas que
respeitam essas permissões. Windows depende também de ACLs do diretório.

Outputs, journal e checkpoints têm retenção configurável e limitada; o contexto
enviado ao modelo também é truncado. Journal/checkpoint/state não constituem uma
transação distribuída nem WAL fsync.
Crash entre arquivos pode deixar uma atualização parcial. Locks órfãos exigem
inspeção/recuperação operacional após verificar que não há escritor ativo. Não há
criptografia em repouso ou migrations automáticas.

## Continuidade honesta

Um failover recebe o estado já persistido e o evento de falha anterior. Não transporta
pensamentos ocultos do modelo, chamadas de ferramenta que o harness não registrou,
arquivos locais ou tokens de respostas interrompidas. Outro harness precisa conectar
e chamar as ferramentas; não há controlador que observe a quota da assinatura do host.

O contexto inclui saídas recentes, é explicitamente marcado como não confiável e
pode ser truncado por caracteres. Isso não é
recuperação semântica/vetorial, nem garantia de manter todos os detalhes em projetos
grandes. Os arquivos originais de memória continuam no armazenamento, sujeitos às
limitações de crash descritas acima. O harness deve fornecer checkpoints concisos.

## Limites de segurança e escala

HTTP é desativado por padrão e precisa de opt-in explícito. Uma instância é um
domínio de confiança. `project_id` não é autenticação e não há
RBAC, isolamento entre clientes hostis ou aprovação por ferramenta. O token HTTP é
compartilhado e autoriza acesso à instância inteira. O operador controla endpoints;
trate alterações de configuração como privilegiadas. Não há sandbox de execução,
controle de egress LOCAL_ONLY, Vault ou teto financeiro.

Não prometer: conformidade MCP completa, compatibilidade com todos os hosts, uso
gratuito garantido, conclusão autônoma de projetos, 24/7 sem supervisão ou qualidade
medida em benchmarks ainda não executados.
