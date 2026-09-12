# As dez ferramentas

| Ferramenta | Entrada principal | Resultado / efeito |
| --- | --- | --- |
| `list_models` | `{}` | Alvos elegíveis configurados; não é catálogo ao vivo |
| `provider_inventory` | `{}` | Registro, endpoint, flags e origem da credencial; sem valores |
| `discover_models` | `provider`, `refresh` opcionais | Consulta catálogo; cache em memória de cinco minutos |
| `health_check` | `{}` | Pequena geração por alvo; pode consumir créditos |
| `project_init` | `project_id`, `workspace`, `repository`, `branch` | Cria/atualiza metadados, não clona o repositório |
| `mission_status` | `project_id`, `mission_id` | Estado e eventos recentes |
| `memory_checkpoint` | `project_id`, `mission_id`, `next_action`, `status` | Snapshot persistido para handoff |
| `delegate` | `prompt`, IDs, `role`, `target` | Uma proposta textual, com tentativas/failover |
| `consensus` | `prompt`, IDs, `models` (2–5) | Respostas de reviewers; pode haver menos alvos distintos |
| `swarm_run` | `goal`, IDs, `roles`, `max_agents` | Workers paralelos e reviewer integrador |

Exemplo de argumentos para o harness chamar `swarm_run`:

```json
{
  "project_id": "loja-demo",
  "mission_id": "m-001",
  "goal": "Propor uma API de catálogo, tela de listagem e testes. Não alegar execução.",
  "roles": ["backend", "frontend", "qa"],
  "max_agents": 3
}
```

Use IDs explícitos para retomar uma missão; omitir `mission_id` em delegação cria
uma nova missão. `target` é `auto` ou `provider:model`. Um alvo explícito deve estar
configurado e respeitar política de custos. Se DZ23_ROTATION for explícita, o alvo
também deve constar nela; adicionar só uma chave não autoriza escapar dessa lista. Chamadas simultâneas não dão acesso
compartilhado ao filesystem do harness: ele deve controlar edições e worktrees.

`config/agents.example.json` é um exemplo descritivo. O runtime não carrega esse
arquivo automaticamente; passe `roles`/limites nas chamadas e na configuração.

Capabilities de vision/tools/embeddings/streaming no inventário descrevem a
superfície desta versão e são `false`. CODING/REASONING são dependentes do modelo,
não resultados de testes de desempenho. Não há execução de function calls retornadas.
