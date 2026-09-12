# Configuração privada

Leia [SECURITY.md](../SECURITY.md). Não guarde credenciais em repositórios, prompts,
exemplos, relatórios ou memória de projetos. O pacote público contém só `.env.example`.

O runtime lê `.env` da pasta de instalação sem sobrescrever variáveis de ambiente
já existentes. Para os providers, `KEY_FILE` lê o segredo de um arquivo montado. Se
um arquivo explicitamente configurado for ilegível, o processo falha: não ignora o
problema. Não há integração Vault implementada e `DZ23_MCP_TOKEN_FILE` não existe;
passe o token HTTP por ambiente privado.

`ALIBABA_API_KEY` e `ALIBABA_BASE_URL` são separados de OpenAI: não substitua
`OPENAI_API_KEY` global para usar Alibaba. Together aceita `TOGETHER_API_KEY` e o
alias legado `TogetherAIAPI_KEY`; Hugging Face aceita `HUGGINGFACE_TOKEN`/`HF_TOKEN`.

Endpoints devem ser HTTP(S), sem usuário/senha, query ou fragmento. Não devolvemos
corpos crus de erro de API, pois podem conter chaves/prompts ecoados. Isso não é
um filtro universal de PII: entradas do usuário e saídas de modelos ainda podem
conter dados sensíveis, que devem ser controlados pelo harness.

O scanner de publicação verifica padrões conhecidos e arquivos permitidos; não
prova ausência de todo segredo possível. O script publica somente PUBLIC_FILES.json
e os caminhos listados nele; `.env`, estado, logs e configurações geradas ficam fora.
