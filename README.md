# Affiliate Autopilot

Plataforma Dockerizada para a operação de afiliados da **Achadinhos**: importar links `meli.la`, preparar mídia, revisar conteúdo e enfileirar publicações por destino. A instalação local atual pode operar em modo real conforme o `.env`; confira as travas antes de iniciar geração paga ou publicação.

## Subir o projeto

1. Abra o Docker Desktop.
2. No PowerShell, entre em `C:\Dev\affiliate-autopilot`.
3. Execute `docker compose up -d --build`.
4. Abra o dashboard em <http://localhost:8088>.

A API fica em <http://localhost:3000>, com health check em `/health`.

### Importar links oficiais

No dashboard, use **Adicionar produtos do Mercado Livre**. Cole até 100 links oficiais `https://meli.la/...`, um por linha, e revise os dados resolvidos. O sistema lê os dados de prévia do destino e tenta consultar a API de itens do Mercado Livre para obter a galeria e a indicação de vídeo. A API pode responder 403 para itens fora do alcance da conta conectada; nesse caso, apenas a imagem de prévia fica disponível. A análise de `video_id` fornece uma referência para conferência, não um arquivo licenciado para republicação automática.

Com duas ou mais fotos oficiais acessíveis, o sistema monta um MP4 vertical local sem custo de IA e usa as fotos como carrossel no Instagram. TikTok e YouTube recebem o MP4 vertical. Sem fotos suficientes, segue para geração de vídeo por IA, sujeita à confirmação de custo na importação. Se a montagem de fotos falhar, o conteúdo fica em falha; uma nova tentativa com IA exige confirmação separada. Depois do QA, `AUTO_PUBLISH_AFTER_QA=false` mantém o conteúdo em `awaiting_approval`. É possível aprovar individualmente ou selecionar vários vídeos na tabela **Conteúdo recente** e escolher os destinos conectados. Cada destino tem estado próprio na fila, inclusive reagendamento por limite informado pela plataforma.

O YouTube pode manter uploads de projetos de API não auditados como privados, mesmo quando o sistema solicita outra visibilidade. O TikTok pode recusar publicação pública de um app ainda não auditado. Essas restrições não são removidas pelo painel.

Para acompanhar a inicialização:

```powershell
docker compose ps
docker compose logs -f scheduler product-worker content-worker snapgen-worker qa-worker publishing-worker analytics-worker
```

## Serviços

- `postgres`: fonte de verdade persistente, com volume Docker.
- `redis`: filas persistidas (AOF) e recuperação de jobs.
- `migrate`: aplica migrations SQL antes da aplicação.
- `api`: health, configuração, dashboard e ações manuais.
- `scheduler`: descoberta, métricas e relatórios recorrentes.
- workers isolados: produto, conteúdo, SnapGen, QA, publicação, analytics e notificações.
- `dashboard`: interface web via Nginx.

Todos os serviços contínuos usam `restart: unless-stopped`. Depois da primeira execução do Compose, eles voltam quando o Docker Desktop iniciar. O script `scripts\install-startup-task.ps1` cria opcionalmente uma tarefa de logon do Windows para executar o Compose; ele deve ser executado pelo próprio usuário em um PowerShell com as permissões adequadas.

## Segurança e idempotência

Cada geração do SnapGen e cada publicação externa reserva uma chave única na tabela `operation_ledger` **antes** da chamada. Em caso de timeout ou resposta incerta, a operação vira `uncertain`, gera alerta crítico e não é repetida automaticamente. Isso privilegia não cobrar nem publicar duas vezes. A reconciliação manual dessa operação será uma tela dedicada no M2.

As duas travas são independentes:

```dotenv
ALLOW_PAID_OPERATIONS=false
ALLOW_REAL_PUBLISHING=false
```

Mesmo com credenciais presentes, os efeitos externos continuam bloqueados enquanto as respectivas travas não forem alteradas conscientemente.

Para um teste real, mantenha `AUTO_PUBLISH_AFTER_QA=false`. Assim, mesmo depois de configurar as APIs sociais, cada primeira publicação exige aprovação explícita no dashboard.

## Configurar SnapGen real

O middleware existente em `C:\Dev\Middleware-snapgen` é acessado pelo container via:

```dotenv
SNAPGEN_MODE=live
SNAPGEN_BASE_URL=http://host.docker.internal:3001
SNAPGEN_API_KEY=...
ALLOW_PAID_OPERATIONS=true
```

Antes disso, confirme que o middleware está ativo e teste seu `/health`. O Autopilot envia vídeos verticais de 10 segundos e consulta o UUID retornado. Não coloque chaves no repositório.

## Configurar Instagram real

```dotenv
PUBLISH_MODE=live
META_GRAPH_VERSION=v23.0
INSTAGRAM_ACCOUNT_ID=...
META_ACCESS_TOKEN=...
TIKTOK_ACCESS_TOKEN=...
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=http://localhost:8088/api/integrations/tiktok/callback/
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_REDIRECT_URI=http://localhost:8088/api/integrations/youtube/callback/
YOUTUBE_PRIVACY_STATUS=private
ALLOW_REAL_PUBLISHING=true
```

É necessário usar conta profissional, app Meta aprovado e permissões oficiais adequadas.

Para o TikTok, prefira o botão **Conectar TikTok** no dashboard. No portal do TikTok, configure o Login Kit para **Desktop** e registre exatamente `http://localhost:8088/api/integrations/tiktok/callback/`. O fluxo usa PKCE, armazena os tokens criptografados e renova automaticamente o acesso. `TIKTOK_ACCESS_TOKEN` permanece apenas como alternativa manual temporária.

Para o YouTube, ative a YouTube Data API v3, configure o escopo `https://www.googleapis.com/auth/youtube.upload` e registre exatamente `http://localhost:8088/api/integrations/youtube/callback/` no cliente OAuth do tipo aplicativo da Web. Depois use **Conectar YouTube** no dashboard. O refresh token é armazenado criptografado e renovado automaticamente; `YOUTUBE_REFRESH_TOKEN` permanece apenas como alternativa manual.

## Configurar email com Resend

```dotenv
NOTIFICATION_MODE=resend
RESEND_API_KEY=...
EMAIL_FROM=Achadinhos <relatorios@seu-dominio.com>
EMAIL_TO=voce@exemplo.com
```

Sem isso, o worker apenas registra uma prévia segura nos logs. Relatórios são agendados para 21h diariamente e 20h aos domingos, no fuso `America/Sao_Paulo`. Alertas críticos entram imediatamente na fila de email.

## Desenvolvimento e validação

```powershell
npm install
npm run typecheck
npm test
npm run lint
docker compose config
docker compose up -d --build
```

## Pendências externas

- O acesso completo à galeria/vídeo de anúncios depende de a conta Mercado Livre conectada poder consultar `/items/{id}`. Um HTTP 403 deixa o sistema apenas com a foto de prévia; não acione geração paga para contornar uma falha de autorização sem conferir os dados.
- Um vídeo referenciado pelo anúncio não é necessariamente um arquivo republicável. O sistema exibe a referência para conferência, mas não baixa nem reutiliza vídeos de terceiros automaticamente.
- A visibilidade pública no TikTok e no YouTube depende das revisões e políticas das plataformas. Confira o estado individual de cada publicação no dashboard.

## Operações úteis

```powershell
# Parar sem apagar dados
docker compose stop

# Reiniciar
docker compose restart

# Remover containers sem apagar volumes
docker compose down
```

Não use `docker compose down -v` em produção: essa opção remove os volumes persistentes.
