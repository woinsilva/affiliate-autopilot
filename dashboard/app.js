const $ = (selector) => document.querySelector(selector);
const fmt = new Intl.NumberFormat('pt-BR');
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const activeStatuses = new Set(['draft', 'scripted', 'generating', 'video_ready']);
const regenerableStatuses = new Set(['awaiting_approval', 'qa_passed', 'qa_failed', 'published']);
const statusInfo = {
  product_saved: { label: 'Produto cadastrado', progress: 0, detail: 'Os dados estão salvos. Inicie a geração quando estiver pronto.' },
  draft: { label: 'Preparando', progress: 10, detail: 'Organizando os dados do produto.' },
  scripted: { label: 'Na fila de geração', progress: 25, detail: 'Roteiro pronto; aguardando o gerador de vídeo.' },
  generating: { label: 'Gerando vídeo', progress: 55, detail: 'A IA está criando o vídeo. Isso pode levar alguns minutos.' },
  video_ready: { label: 'Revisando automaticamente', progress: 85, detail: 'Vídeo pronto; executando a verificação de qualidade.' },
  awaiting_approval: { label: 'Pronto para sua aprovação', progress: 100, detail: 'Abra a prévia, confira o vídeo e aprove quando estiver satisfeito.' },
  qa_passed: { label: 'Aprovado no QA', progress: 100, detail: 'Conteúdo validado e aguardando publicação.' },
  qa_failed: { label: 'Requer ajustes', progress: 100, detail: 'A verificação encontrou pontos que precisam de atenção.' },
  generation_uncertain: { label: 'Geração precisa de atenção', progress: 55, detail: 'O resultado externo ficou incerto e não será cobrado novamente automaticamente.' },
  published: { label: 'Publicado', progress: 100, detail: 'Publicação concluída.' },
  failed: { label: 'Falhou', progress: 100, detail: 'O processo não foi concluído.' },
};
let pipelineNotice = '';
let videoModelsReady = false;
let availableVideoModels = [];
let snapGenAccount = null;
let videoDefaults = { duration: 5, aspectRatio: '9:16', resolution: '720p' };
let socialConnections = { instagram: false, tiktok: false, youtube: false, mercadoLivre: false };
let tiktokCreatorInfo = null;
let batchPending = [];

async function loadConnections() {
  const status = $('#tiktok-status');
  const button = $('#connect-tiktok');
  const youtubeStatus = $('#youtube-status');
  const youtubeButton = $('#connect-youtube');
  const mercadoLivreStatus = $('#mercado-livre-status');
  const mercadoLivreButton = $('#connect-mercado-livre');
  const mercadoLivreFinish = $('#finish-mercado-livre');
  try {
    const response = await fetch('/api/config/status');
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    socialConnections = { ...socialConnections, ...result.connections };
    if (result.connections.mercadoLivre) {
      mercadoLivreStatus.textContent = result.connections.mercadoLivreAccount ? `Mercado Livre: ${result.connections.mercadoLivreAccount}` : 'Mercado Livre conectado';
      mercadoLivreStatus.classList.add('connected');
      mercadoLivreButton.textContent = 'Reconectar Mercado Livre';
      mercadoLivreButton.disabled = false;
      mercadoLivreFinish.hidden = true;
    } else if (!result.connections.mercadoLivreOAuthReady) {
      mercadoLivreStatus.textContent = 'Mercado Livre: falta credencial';
      mercadoLivreStatus.classList.remove('connected');
      mercadoLivreButton.disabled = true;
      mercadoLivreButton.title = 'Preencha MERCADO_LIVRE_CLIENT_ID e MERCADO_LIVRE_CLIENT_SECRET no arquivo .env e reinicie o aplicativo.';
      mercadoLivreFinish.hidden = true;
    } else {
      mercadoLivreStatus.textContent = 'Mercado Livre não conectado';
      mercadoLivreStatus.classList.remove('connected');
      mercadoLivreButton.textContent = 'Conectar Mercado Livre';
      mercadoLivreButton.disabled = false;
      mercadoLivreFinish.hidden = false;
      mercadoLivreFinish.title = 'Use este botão depois de autorizar na outra aba e ser redirecionado ao site público.';
    }
    if (result.connections.tiktok) {
      status.textContent = result.connections.tiktokAccount ? `TikTok: ${result.connections.tiktokAccount}` : 'TikTok conectado';
      status.classList.add('connected');
      button.textContent = 'Reconectar TikTok';
      button.disabled = false;
    } else if (!result.connections.tiktokOAuthReady) {
      status.textContent = 'TikTok: falta credencial';
      status.classList.remove('connected');
      button.textContent = 'Conectar TikTok';
      button.disabled = true;
      button.title = 'Preencha TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET no arquivo .env e reinicie o aplicativo.';
    } else {
      status.textContent = 'TikTok não conectado';
      status.classList.remove('connected');
      button.textContent = 'Conectar TikTok';
      button.disabled = false;
    }
    if (result.connections.youtube) {
      youtubeStatus.textContent = result.connections.youtubeAccount ? `YouTube: ${result.connections.youtubeAccount}` : 'YouTube conectado';
      youtubeStatus.classList.add('connected');
      youtubeButton.textContent = 'Reconectar YouTube';
      youtubeButton.disabled = false;
    } else if (!result.connections.youtubeOAuthReady) {
      youtubeStatus.textContent = 'YouTube: falta credencial';
      youtubeStatus.classList.remove('connected');
      youtubeButton.textContent = 'Conectar YouTube';
      youtubeButton.disabled = true;
      youtubeButton.title = 'Preencha YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no arquivo .env e reinicie o aplicativo.';
    } else {
      youtubeStatus.textContent = 'YouTube não conectado';
      youtubeStatus.classList.remove('connected');
      youtubeButton.textContent = 'Conectar YouTube';
      youtubeButton.disabled = false;
    }
  } catch (error) {
    status.textContent = 'TikTok indisponível';
    button.title = error.message;
    youtubeStatus.textContent = 'YouTube indisponível';
    youtubeButton.title = error.message;
    mercadoLivreStatus.textContent = 'Mercado Livre indisponível';
    mercadoLivreButton.title = error.message;
  }
}

async function loadPublishingLimits() {
  const status = $('#publishing-limits-status');
  try {
    const response = await fetch('/api/integrations/publishing-limits');
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const instagram = result.instagram?.current;
    const scheduledCount = Object.values(result.scheduled || {}).reduce((total, item) => total + Number(item?.count || 0), 0);
    status.textContent = instagram
      ? `Instagram: ${instagram.usage}/${instagram.total}${scheduledCount ? ` · ${scheduledCount} agendado(s)` : ''}`
      : `Cotas sociais: monitoradas${scheduledCount ? ` · ${scheduledCount} agendado(s)` : ''}`;
    status.title = 'Instagram é consultado preventivamente. TikTok e YouTube são agendados automaticamente quando a própria plataforma informa um limite.';
  } catch (error) {
    status.textContent = 'Cotas sociais: indisponíveis';
    status.title = error.message;
  }
}

function handleTikTokCallbackNotice() {
  const parameters = new URLSearchParams(window.location.search);
  const state = parameters.get('tiktok');
  if (!state) return;
  if (state === 'connected') pipelineNotice = 'Conta TikTok conectada. Agora ela está disponível na etapa de publicação.';
  else if (state === 'error') window.alert(`Não foi possível conectar o TikTok: ${parameters.get('message') || 'erro não informado'}`);
  parameters.delete('tiktok');
  parameters.delete('message');
  const query = parameters.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

function handleYouTubeCallbackNotice() {
  const parameters = new URLSearchParams(window.location.search);
  const state = parameters.get('youtube');
  if (!state) return;
  if (state === 'connected') pipelineNotice = 'Canal do YouTube conectado. Agora ele está disponível na etapa de publicação.';
  else if (state === 'error') window.alert(`Não foi possível conectar o YouTube: ${parameters.get('message') || 'erro não informado'}`);
  parameters.delete('youtube');
  parameters.delete('message');
  const query = parameters.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

function card(label, value, accent = false) { return `<div class="card ${accent ? 'accent' : ''}"><p>${label}</p><strong>${value}</strong></div>`; }
function getStatusInfo(status) { return statusInfo[status] || { label: status, progress: 0, detail: 'Processando…' }; }
function publicationLabel(publication) {
  const platform = publication.platform === 'tiktok' ? 'TikTok' : publication.platform === 'youtube' ? 'YouTube' : 'Instagram';
  const states = { pending: 'na fila', publishing: 'enviando', scheduled: 'agendado por limite', published: 'publicado', failed: 'falhou', uncertain: 'verificação necessária' };
  return `${platform}: ${states[publication.status] || publication.status}`;
}
function publicationDetails(publications) {
  if (!Array.isArray(publications) || !publications.length) return '';
  return publications.map((publication) => {
    const error = publication.error ? `<small class="publication-error">${escapeHtml(publication.error)}</small>` : '';
    const schedule = publication.status === 'scheduled' && publication.nextAttemptAt
      ? `<small>Próxima tentativa automática: ${new Date(publication.nextAttemptAt).toLocaleString('pt-BR')}</small>`
      : '';
    const link = publication.externalUrl ? ` <a href="${escapeHtml(publication.externalUrl)}" target="_blank" rel="noopener noreferrer">Abrir</a>` : '';
    return `<div class="publication-state publication-${escapeHtml(publication.status)}"><strong>${escapeHtml(publicationLabel(publication))}</strong>${link}${schedule}${error}</div>`;
  }).join('');
}
function generationFailureDetail(error) {
  if (!error) return getStatusInfo('failed').detail;
  if (error.includes('đính kèm ảnh')) return 'O SnapGen recusou a geração porque faltava uma imagem do produto.';
  if (error.includes('#cg33') || error.includes('gói dịch vụ không khả dụng')) return 'O serviço de geração do SnapGen estava temporariamente indisponível (#cg33). Aguarde antes de tentar novamente.';
  return `O SnapGen respondeu: ${error}`;
}

function selectedVideoSettings() {
  const model = $('#generation-model').value;
  if (!videoModelsReady || !model) throw new Error('A lista de modelos ainda não está disponível. Aguarde alguns segundos.');
  return {
    model,
    duration: Number($('#generation-duration').value),
    aspectRatio: $('#generation-aspect').value,
    resolution: $('#generation-resolution').value,
    mode: $('#generation-mode').value,
  };
}

function durationOptions(model) {
  if (Array.isArray(model.durations)) return model.durations;
  const values = [];
  for (let value = model.durations.min; value <= model.durations.max; value += 1) values.push(value);
  return values;
}

function fillSelect(selector, values, preferred, label = (value) => value) {
  const select = $(selector);
  select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}" ${String(value) === String(preferred) ? 'selected' : ''}>${escapeHtml(label(value))}</option>`).join('');
  if (!select.value && select.options.length) select.selectedIndex = 0;
  select.disabled = values.length <= 1;
}

function configureSelectedModel() {
  const model = availableVideoModels.find((item) => item.id === $('#generation-model').value);
  if (!model) return;
  const durations = durationOptions(model);
  fillSelect('#generation-duration', durations, durations.includes(videoDefaults.duration) ? videoDefaults.duration : durations[0], (value) => `${value} segundos`);
  fillSelect('#generation-aspect', model.aspectRatios, model.aspectRatios.includes(videoDefaults.aspectRatio) ? videoDefaults.aspectRatio : model.aspectRatios[0]);
  const resolutions = model.resolutions.length ? model.resolutions : [''];
  fillSelect('#generation-resolution', resolutions, model.resolutions.includes(videoDefaults.resolution) ? videoDefaults.resolution : resolutions[0], (value) => value || 'Automática');
  const modes = model.modes.length ? model.modes : [''];
  fillSelect('#generation-mode', modes, modes[0], (value) => value || 'Padrão');
  renderSelectedModelDetails();
}

function formatModelDurations(durations) {
  if (Array.isArray(durations)) return durations.map((duration) => `${duration}s`).join(', ');
  if (durations && Number.isFinite(durations.min) && Number.isFinite(durations.max)) return `${durations.min}s a ${durations.max}s`;
  return 'Não informado';
}

function modelAttemptSummary(attempt) {
  if (!attempt) return { label: 'Ainda não testado neste sistema', className: '' };
  if (attempt.status === 'succeeded') return { label: 'Funcionou na última tentativa', className: 'model-ok' };
  if (attempt.status === 'reserved' || attempt.status === 'processing') return { label: 'Geração em andamento', className: '' };
  if (attempt.status === 'failed') {
    const detail = attempt.error ? generationFailureDetail(attempt.error) : 'A última tentativa falhou.';
    return { label: detail, className: 'model-warning' };
  }
  return { label: `Último estado: ${attempt.status}`, className: '' };
}

function renderSelectedModelDetails() {
  const panel = $('#model-details');
  const model = availableVideoModels.find((item) => item.id === $('#generation-model').value);
  if (!model) {
    panel.innerHTML = '<span class="muted">Selecione um modelo para ver suas capacidades.</span>';
    return;
  }
  const attempt = modelAttemptSummary(model.lastAttempt);
  const modes = Array.isArray(model.modes) && model.modes.length ? model.modes.join(', ') : 'Padrão';
  const settings = selectedVideoSettings();
  const sameConfiguration = model.lastAttempt
    && String(model.lastAttempt.duration ?? '') === String(settings.duration)
    && String(model.lastAttempt.aspect_ratio ?? '') === settings.aspectRatio
    && String(model.lastAttempt.resolution ?? '') === settings.resolution
    && String(model.lastAttempt.mode ?? '') === settings.mode;
  const observedCost = sameConfiguration ? model.lastAttempt?.used_credit ?? model.lastAttempt?.estimated_credit : null;
  const costLabel = observedCost == null ? 'Informado pelo SnapGen após o envio' : `Último valor observado: ${fmt.format(Number(observedCost))} crédito(s)`;
  panel.innerHTML = `
    <div class="model-detail"><small>Família</small><strong>${escapeHtml(model.family)}</strong></div>
    <div class="model-detail"><small>Duração disponível</small><strong>${escapeHtml(formatModelDurations(model.durations))}</strong></div>
    <div class="model-detail"><small>Resoluções</small><strong>${escapeHtml((model.resolutions || []).join(', ') || 'Não informado')}</strong></div>
    <div class="model-detail"><small>Formatos</small><strong>${escapeHtml((model.aspectRatios || []).join(', ') || 'Não informado')}</strong></div>
    <div class="model-detail"><small>Modos</small><strong>${escapeHtml(modes)}</strong></div>
    <div class="model-detail"><small>Imagens de referência</small><strong>${escapeHtml(model.maxReferenceImages ?? 'Não informado')}</strong></div>
    <div class="model-detail"><small>Estender vídeo</small><strong>${model.supportsExtend ? 'Sim' : 'Não informado pela API'}</strong></div>
    <div class="model-detail ${observedCost == null ? 'model-warning' : 'model-ok'}"><small>Custo em créditos</small><strong>${escapeHtml(costLabel)}</strong></div>
    <div class="model-detail wide ${attempt.className}"><small>Experiência neste sistema</small><strong>${escapeHtml(attempt.label)}</strong></div>`;
}

async function loadVideoModels() {
  const select = $('#generation-model');
  try {
    const response = await fetch('/api/video/models');
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (!result.models.length) throw new Error('Nenhum modelo compatível foi encontrado');
    availableVideoModels = result.models;
    videoDefaults = { duration: result.duration, aspectRatio: result.aspectRatio, resolution: result.resolution };
    select.innerHTML = result.models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === result.selected ? 'selected' : ''}>${escapeHtml(model.id)} · ${escapeHtml(model.family)}</option>`).join('');
    if (!select.value) select.selectedIndex = 0;
    select.disabled = false;
    videoModelsReady = true;
    $('#model-help').textContent = `${result.models.length} modelo(s) disponíveis para geração com imagem. Escolha os parâmetros permitidos pela IA. O custo oficial é registrado quando o SnapGen aceita a solicitação.`;
    configureSelectedModel();
  } catch (error) {
    select.innerHTML = '<option value="">Modelos indisponíveis</option>';
    select.disabled = true;
    videoModelsReady = false;
    availableVideoModels = [];
    $('#model-help').textContent = `Não foi possível consultar os modelos: ${error.message}`;
    $('#model-details').innerHTML = '<span class="muted">As capacidades dos modelos estão temporariamente indisponíveis.</span>';
  }
}

async function loadSnapGenAccount() {
  const badge = $('#snapgen-credits');
  try {
    const response = await fetch('/api/video/account');
    const account = await readJsonResponse(response);
    if (!response.ok) throw new Error(account.error || `HTTP ${response.status}`);
    snapGenAccount = account;
    badge.classList.remove('credit-error');
    badge.textContent = `Créditos: ${fmt.format(account.availableCredit)} disponíveis${account.lockedCredit ? ` · ${fmt.format(account.lockedCredit)} bloqueados` : ''}`;
    return account;
  } catch (error) {
    snapGenAccount = null;
    badge.classList.add('credit-error');
    badge.textContent = 'Créditos: indisponível';
    throw error;
  }
}

async function confirmPaidGeneration(action, settings, quantity = 1) {
  let account = snapGenAccount;
  try { account = await loadSnapGenAccount(); } catch { /* A falha fica visível na confirmação. */ }
  const selected = availableVideoModels.find((item) => item.id === settings.model);
  const sameConfiguration = selected?.lastAttempt
    && String(selected.lastAttempt.duration ?? '') === String(settings.duration)
    && String(selected.lastAttempt.aspect_ratio ?? '') === settings.aspectRatio
    && String(selected.lastAttempt.resolution ?? '') === settings.resolution
    && String(selected.lastAttempt.mode ?? '') === settings.mode;
  const observed = sameConfiguration ? selected?.lastAttempt?.used_credit ?? selected?.lastAttempt?.estimated_credit : null;
  const balance = account ? `Saldo oficial agora: ${fmt.format(account.availableCredit)} crédito(s) disponíveis${account.lockedCredit ? ` e ${fmt.format(account.lockedCredit)} bloqueado(s)` : ''}.` : 'Não foi possível confirmar o saldo agora.';
  const cost = observed == null
    ? 'O SnapGen só informa o custo exato depois que aceita a solicitação.'
    : `Último custo observado para este modelo: ${fmt.format(Number(observed))} crédito(s) por geração. O preço pode mudar.`;
  return window.confirm(`${action}\n\nModelo: ${settings.model}\nDuração: ${settings.duration}s · Formato: ${settings.aspectRatio} · Resolução: ${settings.resolution || 'automática'}${settings.mode ? ` · Modo: ${settings.mode}` : ''}\nQuantidade máxima: ${quantity} geração(ões).\n${balance}\n${cost}\n\nDeseja continuar?`);
}

function renderPipeline(items) {
  const panel = $('#pipeline-status');
  const relevant = items.filter((item) => activeStatuses.has(item.status) || ['product_saved', 'awaiting_approval', 'generation_uncertain', 'qa_failed', 'failed'].includes(item.status)).slice(0, 5);
  if (!relevant.length && !pipelineNotice) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  panel.innerHTML = `<div class="pipeline-head"><div><p class="eyebrow">ANDAMENTO</p><h2>${relevant.some((item) => activeStatuses.has(item.status)) ? 'Seus vídeos estão sendo preparados' : 'Conteúdo aguardando sua atenção'}</h2></div><span class="live-indicator"><i></i> Atualização automática</span></div>
    ${pipelineNotice ? `<p class="pipeline-notice">${escapeHtml(pipelineNotice)}</p>` : ''}
    <div class="pipeline-items">${relevant.map((item) => {
      const info = getStatusInfo(item.status);
      const spinning = activeStatuses.has(item.status);
      const detail = item.status === 'failed' ? generationFailureDetail(item.generation_error) : info.detail;
      const model = item.generation_model ? ` · Modelo: ${item.generation_model}` : '';
      return `<div class="pipeline-item">
        <div class="pipeline-icon ${spinning ? 'spinning' : ''}">${spinning ? '' : info.progress === 100 ? '✓' : '!'}</div>
        <div class="pipeline-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(info.label)} · ${escapeHtml(detail)}${escapeHtml(model)}</span><div class="progress"><i style="width:${info.progress}%"></i></div></div>
        <div class="pipeline-actions">${item.status === 'product_saved' ? `<button class="generate pipeline-preview" data-product-id="${item.product_id}">Gerar vídeo</button>` : item.status === 'failed' ? `<button class="retry-generation pipeline-preview" data-id="${item.id}">Tentar novamente</button>` : item.status === 'awaiting_approval' ? `<button class="preview pipeline-preview" data-id="${item.id}" onclick="showPreview(this.dataset.id)">Ver prévia</button>` : ''}${item.id && ['qa_failed','failed','generation_uncertain','awaiting_approval'].includes(item.status) ? `<button class="dismiss-pipeline secondary" data-id="${item.id}">Dispensar</button>` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  panel.querySelectorAll('.generate').forEach((button) => button.addEventListener('click', (event) => startProductGeneration(event.currentTarget)));
  panel.querySelectorAll('.retry-generation').forEach((button) => button.addEventListener('click', (event) => retryGeneration(event.currentTarget)));
  panel.querySelectorAll('.dismiss-pipeline').forEach((button) => button.addEventListener('click', (event) => dismissPipelineItem(event.currentTarget)));
}

async function dismissPipelineItem(button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Removendo…';
  try {
    const response = await fetch(`/api/content/${encodeURIComponent(button.dataset.id)}/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = 'Item removido das pendências. O histórico do conteúdo foi preservado.';
    await load();
  } catch (error) {
    window.alert(`Não foi possível remover o item: ${error.message}`);
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Serviço temporariamente indisponível (HTTP ${response.status}). Tente novamente.`); }
}

async function load() {
  try {
    const response = await fetch('/api/dashboard/achadinhos');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    $('#status').textContent = '● Sistema online';
    $('#cards').innerHTML = [
      card('Produtos', fmt.format(data.counts.products)), card('Conteúdos', fmt.format(data.counts.content)),
      card('Publicados', fmt.format(data.counts.published), true), card('Visualizações', fmt.format(data.metrics.views)),
      card('Cliques', fmt.format(data.metrics.clicks)), card('Receita atribuída', money.format(data.metrics.revenue), true),
    ].join('');
    $('#safety').innerHTML = `<span>SnapGen: ${data.modes.snapgen}</span><span>Publicação: ${data.modes.publishing}</span><span>Email: ${data.modes.notifications}</span><span>Operações externas protegidas por idempotência</span>`;
    renderPipeline(data.attention || []);
    const previouslySelected = new Set([...document.querySelectorAll('.batch-item:checked')].map((input) => input.value));
    batchPending = data.recent.filter((item) => item.status === 'awaiting_approval');
    $('#batch-publish').hidden = batchPending.length === 0;
    $('#batch-select-all').disabled = batchPending.length === 0;
    document.querySelectorAll('.batch-platform').forEach((input) => { input.disabled = !socialConnections[input.value]; });
    updateBatchTikTokOptions();
    $('#recent').innerHTML = data.recent.length ? data.recent.map((item) => `<tr><td>${item.status === 'awaiting_approval' ? `<input class="batch-item" type="checkbox" value="${item.id}" aria-label="Selecionar ${escapeHtml(item.title)}">` : ''}</td><td>${escapeHtml(item.title)}</td><td><span class="tag ${activeStatuses.has(item.status) ? 'tag-active' : ''}">${escapeHtml(getStatusInfo(item.status).label)}</span>${publicationDetails(item.publications)}</td><td>${item.qa_score ?? '—'}</td><td><div class="row-actions">${item.status === 'product_saved' ? `<button class="generate" data-product-id="${item.product_id}">Gerar vídeo</button>` : `<button class="preview" data-id="${item.id}" onclick="showPreview(this.dataset.id)">${item.status === 'awaiting_approval' ? 'Revisar e publicar' : 'Visualizar'}</button>`}${item.status === 'failed' ? `<button class="retry-generation" data-id="${item.id}">Tentar novamente</button>` : ''}${regenerableStatuses.has(item.status) ? `<button class="regenerate secondary" data-product-id="${item.product_id}">Gerar outro vídeo</button>` : ''}${item.status === 'awaiting_approval' ? `<button class="reject secondary" data-id="${item.id}">Reprovar vídeo</button>` : ''}</div></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Nenhum produto cadastrado. Adicione um produto acima para começar.</td></tr>';
    document.querySelectorAll('.batch-item').forEach((input) => { input.checked = previouslySelected.has(input.value); });
    $('#batch-select-all').checked = batchPending.length > 0 && [...document.querySelectorAll('.batch-item')].every((input) => input.checked);
    document.querySelectorAll('#recent .reject').forEach((button) => button.addEventListener('click', (event) => rejectContent(event.currentTarget)));
    document.querySelectorAll('#recent .generate').forEach((button) => button.addEventListener('click', (event) => startProductGeneration(event.currentTarget)));
    document.querySelectorAll('#recent .retry-generation').forEach((button) => button.addEventListener('click', (event) => retryGeneration(event.currentTarget)));
    document.querySelectorAll('#recent .regenerate').forEach((button) => button.addEventListener('click', (event) => regenerateProduct(event.currentTarget)));
    $('#alerts').innerHTML = data.alerts.length ? data.alerts.map((item) => `<div class="alert"><p>${escapeHtml(item.message)}</p><small>${escapeHtml(item.source)} · ${new Date(item.created_at).toLocaleString('pt-BR')}</small></div>`).join('') : '<p class="empty">Nenhum alerta aberto.</p>';
    $('#updated').textContent = `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch (error) { $('#status').textContent = `● Indisponível`; console.error(error); }
}

async function action(button, path, body = {}) { button.disabled = true; try { const response = await fetch(`/api${path}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); setTimeout(load, 1500); } finally { button.disabled = false; } }
function escapeHtml(value) { const element = document.createElement('div'); element.textContent = String(value); return element.innerHTML; }

async function prepareImports() {
  const urls = $('#official-links').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const invalid = urls.filter((value) => { try { return new URL(value).hostname !== 'meli.la'; } catch { return true; } });
  if (!urls.length) { $('#import-message').textContent = 'Cole pelo menos um link.'; return; }
  if (invalid.length) { $('#import-message').textContent = `${invalid.length} link(s) não pertencem ao domínio meli.la.`; return; }
  const unique = [...new Set(urls)];
  const button = $('#prepare');
  button.disabled = true;
  $('#import-message').textContent = `Buscando dados de ${unique.length} produto(s)…`;
  try {
    const response = await fetch('/api/products/resolve-official', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ urls: unique }) });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const resolved = new Map(result.resolved.map((product) => [product.affiliateUrl, product]));
    const failures = new Map(result.failed.map((failure) => [failure.affiliateUrl, failure.error]));
    renderImportRows(unique, resolved, failures);
    $('#import-message').textContent = `${result.resolved.length}/${unique.length} preenchido(s) automaticamente. Confira os dados antes de gerar.`;
  } catch (error) {
    renderImportRows(unique, new Map(), new Map(unique.map((url) => [url, error.message])));
    $('#import-message').textContent = 'A busca automática falhou; os campos continuam disponíveis para edição.';
  } finally { button.disabled = false; }
}

function renderImportRows(urls, resolved, failures) {
  $('#import-rows').innerHTML = urls.map((url, index) => {
    const product = resolved.get(url) || {};
    const failure = failures.get(url);
    const price = product.price == null ? '' : String(product.price).replace('.', ',');
    const listingVideo = product.listingVideo;
    const listingVideoMessage = listingVideo ? `<div class="listing-video listing-video-${escapeHtml(listingVideo.status)}"><strong>${listingVideo.status === 'found' ? 'Vídeo no anúncio para conferência' : listingVideo.status === 'not_found' ? 'Sem vídeo original na API' : listingVideo.status === 'authorization_required' ? 'Análise de mídia pendente' : 'Mídia não verificada'}</strong><span>${escapeHtml(listingVideo.message || '')}</span>${listingVideo.previewUrl ? `<a href="${escapeHtml(listingVideo.previewUrl)}" target="_blank" rel="noopener noreferrer">Visualizar vídeo informado pelo anúncio</a>` : ''}</div>` : '';
    const imageUrls = product.imageUrls?.length ? product.imageUrls : product.imageUrl ? [product.imageUrl] : [];
    return `<div class="import-row" data-url="${escapeHtml(url)}">
      <div class="link-chip">${escapeHtml(url)} ${failure ? `<span class="resolve-error">· ${escapeHtml(failure)}</span>` : '<span class="resolve-ok">· dados encontrados</span>'}</div>
      ${listingVideoMessage}
      <div class="field"><label>Título do produto *</label><input class="product-title" maxlength="240" placeholder="Nome exibido no anúncio" value="${escapeHtml(product.title || '')}"></div>
      <div class="field"><label>Preço de referência</label><input class="product-price" inputmode="decimal" placeholder="0,00" value="${escapeHtml(price)}"></div>
      <div class="field"><label>ID do anúncio</label><input class="product-id" placeholder="MLB123456" value="${escapeHtml(product.externalId || '')}"></div>
      <div class="field"><label>Imagem pública</label><input class="product-image" type="url" placeholder="https://..." value="${escapeHtml(product.imageUrl || '')}"></div>
      <div class="field"><label>Imagens do anúncio para carrossel (uma URL por linha)</label><textarea class="product-images" rows="3" placeholder="https://http2.mlstatic.com/...">${escapeHtml(imageUrls.join('\n'))}</textarea><small>${imageUrls.length} imagem(ns) encontrada(s). Com duas ou mais, o sistema monta um vídeo sem custo de IA e publica carrossel no Instagram.</small></div>
      <div class="field"><label>Mídia preferida</label><select class="media-preference"><option value="auto">Automático: fotos quando houver, senão IA</option><option value="slideshow">Carrossel de fotos</option><option value="ai">Vídeo por IA</option></select></div>
      <div class="field"><label>Destino validado</label><input class="product-destination" type="url" placeholder="https://www.mercadolivre.com.br/..." value="${escapeHtml(product.destinationUrl || '')}"></div>
      <button class="remove" type="button" data-index="${index}">Remover</button>
    </div>`;
  }).join('') + '<button id="submit-import" class="submit-import">Confirmar e preparar conteúdo</button>';
  document.querySelectorAll('.remove').forEach((button) => button.addEventListener('click', (event) => event.currentTarget.closest('.import-row').remove()));
  $('#submit-import').addEventListener('click', submitImports);
}

async function submitImports(event) {
  const button = event.currentTarget;
  const originalLabel = button.textContent;
  let video;
  try { video = selectedVideoSettings(); }
  catch (error) { $('#import-message').textContent = error.message; return; }
  const rows = [...document.querySelectorAll('.import-row')];
  const products = rows.map((row) => {
    const rawPrice = row.querySelector('.product-price').value.trim().replace('.', '').replace(',', '.');
    return {
      affiliateUrl: row.dataset.url,
      title: row.querySelector('.product-title').value.trim(),
      externalId: row.querySelector('.product-id').value.trim() || undefined,
      price: rawPrice ? Number(rawPrice) : undefined,
      imageUrl: row.querySelector('.product-image').value.trim() || undefined,
      imageUrls: row.querySelector('.product-images').value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean),
      mediaPreference: row.querySelector('.media-preference').value,
      destinationUrl: row.querySelector('.product-destination').value.trim() || undefined,
      labels: ['achadinhos'],
      startPipeline: true,
    };
  });
  if (!products.length || products.some((product) => product.title.length < 3)) { $('#import-message').textContent = 'Preencha o título em todas as linhas.'; return; }
  const aiCount = products.filter((product) => product.mediaPreference === 'ai' || product.imageUrls.length < 2).length;
  if (aiCount && !await confirmPaidGeneration(`Confirmar ${aiCount} possível(is) geração(ões) por IA? Os demais usarão fotos do anúncio.`, video, aiCount)) return;
  button.disabled = true;
  button.classList.add('button-loading');
  button.textContent = 'Enviando para geração…';
  $('#import-message').textContent = 'Registrando os produtos e iniciando a fila. Não feche esta página ainda.';
  try {
    const response = await fetch('/api/products/import-official', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ brandSlug:'achadinhos', ...video, products }) });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      const details = Array.isArray(result.issues) ? result.issues.map((issue) => {
        const index = issue.path?.[0] === 'products' && Number.isInteger(issue.path?.[1]) ? issue.path[1] : null;
        const row = index == null ? null : rows[index];
        const product = row?.querySelector('.product-title')?.value.trim() || row?.dataset.url;
        return `${product ? `${product}: ` : ''}${issue.message}`;
      }).join(' | ') : '';
      throw new Error(details || result.error || `HTTP ${response.status}`);
    }
    const resumed = result.duplicates.filter((item) => item.queued).length;
    const retried = result.duplicates.filter((item) => item.action === 'retry').length;
    const started = result.imported.filter((item) => item.queued).length + resumed;
    if (started) {
      pipelineNotice = retried
        ? `${retried} tentativa(s) reiniciada(s) com os parâmetros escolhidos. Você pode continuar usando a página; o andamento será atualizado automaticamente.`
        : `${started} produto(s) recebido(s). Você pode continuar usando a página; o andamento será atualizado automaticamente.`;
      $('#import-message').textContent = retried ? 'Nova tentativa iniciada. Acompanhe o andamento logo abaixo.' : 'Conteúdo em preparação. Acompanhe o andamento logo abaixo.';
      $('#official-links').value = '';
      $('#import-rows').innerHTML = '';
    } else {
      $('#import-message').textContent = `${result.duplicates.length} produto(s) já possuíam conteúdo e não foram gerados novamente.`;
    }
    await load();
  } catch (error) { $('#import-message').textContent = `Erro: ${error.message}`; }
  finally { button.disabled = false; button.classList.remove('button-loading'); button.textContent = originalLabel; }
}

function readTikTokPublishSettings() {
    const privacyLevel = $('#tiktok-privacy')?.value || '';
    const title = $('#tiktok-caption')?.value.trim() || '';
    const musicUsageAccepted = Boolean($('#tiktok-music-consent')?.checked);
    const commercialContent = $('#tiktok-commercial')?.value || 'none';
    if (!privacyLevel) throw new Error('Escolha quem poderá ver o vídeo no TikTok.');
    if (!title) throw new Error('Revise a legenda antes de publicar no TikTok.');
    if (!musicUsageAccepted) throw new Error('Confirme a declaração de uso de música exigida pelo TikTok.');
    if (commercialContent === 'branded_content' && privacyLevel === 'SELF_ONLY') throw new Error('Conteúdo de marca não pode ser publicado como “Somente eu”.');
    return {
      title, privacyLevel, musicUsageAccepted, commercialContent,
      allowComment: Boolean($('#tiktok-comment')?.checked),
      allowDuet: Boolean($('#tiktok-duet')?.checked),
      allowStitch: Boolean($('#tiktok-stitch')?.checked),
      isAiGenerated: Boolean($('#tiktok-aigc')?.checked),
    };
}

function updateBatchTikTokOptions() {
  const enabled = Boolean(document.querySelector('.batch-platform[value="tiktok"]:checked:not(:disabled)'));
  $('#batch-tiktok-options').hidden = !enabled;
  if (!enabled || !batchPending.length || tiktokCreatorInfo) return;
  fetch('/api/integrations/tiktok/creator-info?brandSlug=achadinhos').then(readJsonResponse).then((info) => {
    if (!Array.isArray(info.privacy_level_options)) throw new Error(info.error || 'A conta não informou as opções de privacidade');
    tiktokCreatorInfo = info;
    $('#batch-tiktok-privacy').innerHTML = '<option value="">Escolha a visibilidade</option>' + info.privacy_level_options.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(privacyLabel(value))}</option>`).join('');
  }).catch((error) => { $('#batch-message').textContent = `TikTok indisponível: ${error.message}`; });
}

async function publishBatch() {
  const ids = [...document.querySelectorAll('.batch-item:checked')].map((input) => input.value);
  const platforms = [...document.querySelectorAll('.batch-platform:checked:not(:disabled)')].map((input) => input.value);
  if (!ids.length || !platforms.length) { window.alert('Selecione ao menos um vídeo e um destino conectado.'); return; }
  const privacyLevel = $('#batch-tiktok-privacy').value;
  if (platforms.includes('tiktok')) {
    if (!privacyLevel) { window.alert('Escolha a visibilidade do TikTok para o lote.'); return; }
    if (!$('#batch-music-consent').checked) { window.alert('Confirme o uso de música do TikTok para o lote.'); return; }
    if (privacyLevel === 'SELF_ONLY') { window.alert('Conteúdo de afiliado não pode ser enviado como “Somente eu” no TikTok.'); return; }
  }
  if (!window.confirm(`Aprovar ${ids.length} vídeo(s) para ${platforms.join(', ')}? Revise as prévias antes de confirmar. Cada publicação será enfileirada.`)) return;
  const button = $('#batch-submit');
  button.disabled = true;
  const successes = [];
  const failures = [];
  try {
    for (const [index, id] of ids.entries()) {
      $('#batch-message').textContent = `Enfileirando ${index + 1}/${ids.length}…`;
      try {
        const detailsResponse = await fetch(`/api/content/${encodeURIComponent(id)}`);
        const item = await readJsonResponse(detailsResponse);
        if (!detailsResponse.ok) throw new Error(item.error || `HTTP ${detailsResponse.status}`);
        const tiktok = platforms.includes('tiktok') ? {
          title: String(item.caption || item.product_title || '').slice(0, 2200), privacyLevel,
          musicUsageAccepted: true, commercialContent: 'branded_content',
          allowComment: false, allowDuet: false, allowStitch: false,
          isAiGenerated: item.media_kind === 'ai_video',
        } : undefined;
        const response = await fetch(`/api/content/${encodeURIComponent(id)}/publish`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platforms, tiktok }),
        });
        const result = await readJsonResponse(response);
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        successes.push(id);
      } catch (error) { failures.push(`${id}: ${error.message}`); }
    }
    pipelineNotice = `${successes.length} vídeo(s) aceito(s) para publicação${failures.length ? `; ${failures.length} falharam. Confira o erro abaixo.` : '.'}`;
    await load();
    $('#batch-message').textContent = failures.length ? failures.join(' | ') : `${successes.length} vídeo(s) na fila. Acompanhe o estado por plataforma na tabela.`;
  } finally { button.disabled = false; $('#batch-select-all').checked = false; }
}

async function publishSelectedPlatforms(button) {
  const platforms = [...document.querySelectorAll('.approval-platform:checked:not(:disabled)')].map((input) => input.value);
  if (!platforms.length) { window.alert('Selecione pelo menos um destino ainda não publicado.'); return; }
  let tiktok;
  try {
    if (platforms.includes('tiktok')) tiktok = readTikTokPublishSettings();
  } catch (error) {
    window.alert(error.message);
    return;
  }
  const labels = platforms.map((platform) => ({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' })[platform] || platform);
  const confirmed = window.confirm(`Aprovar e publicar em ${labels.join(', ')}? Esta ação enviará o vídeo para as contas conectadas.`);
  if (!confirmed) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Enviando para publicação…';
  try {
    const response = await fetch(`/api/content/${encodeURIComponent(button.dataset.id)}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platforms, tiktok }),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = result.queued?.length
      ? `Publicação enviada para ${result.queued.map((platform) => ({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' })[platform] || platform).join(', ')}. O painel acompanhará cada destino.`
      : 'Os destinos selecionados já haviam sido publicados.';
    const dialog = $('#preview-dialog');
    if (dialog?.open) dialog.close();
    await load();
  } catch (error) {
    window.alert(`Não foi possível iniciar a publicação: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function privacyLabel(value) {
  return ({ PUBLIC_TO_EVERYONE: 'Todos', FOLLOWER_OF_CREATOR: 'Seguidores', MUTUAL_FOLLOW_FRIENDS: 'Amigos', SELF_ONLY: 'Somente eu' })[value] || value;
}

async function loadTikTokPublishingOptions(caption, mediaKind) {
  const panel = $('#tiktok-publish-settings');
  if (!panel) return;
  panel.innerHTML = '<p class="muted">Consultando as opções atuais da conta TikTok…</p>';
  try {
    const response = await fetch('/api/integrations/tiktok/creator-info?brandSlug=achadinhos');
    const info = await readJsonResponse(response);
    if (!response.ok) throw new Error(info.error || `HTTP ${response.status}`);
    tiktokCreatorInfo = info;
    const privacyOptions = (info.privacy_level_options || []).map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(privacyLabel(value))}</option>`).join('');
    panel.innerHTML = `<div class="tiktok-account">${info.creator_avatar_url ? `<img src="${escapeHtml(info.creator_avatar_url)}" alt="">` : ''}<div><strong>${escapeHtml(info.creator_nickname || info.creator_username || 'Conta conectada')}</strong><small>@${escapeHtml(info.creator_username || 'TikTok')}</small></div></div>
      <div class="field"><label for="tiktok-caption">Legenda do TikTok</label><textarea id="tiktok-caption" maxlength="2200" rows="4">${escapeHtml(caption || '')}</textarea></div>
      <div class="field"><label for="tiktok-privacy">Quem pode assistir *</label><select id="tiktok-privacy"><option value="">Escolha antes de publicar</option>${privacyOptions}</select></div>
      <fieldset class="tiktok-options"><legend>Interações — desmarcadas por padrão</legend>
        <label><input id="tiktok-comment" type="checkbox" ${info.comment_disabled ? 'disabled' : ''}> Permitir comentários</label>
        <label><input id="tiktok-duet" type="checkbox" ${info.duet_disabled ? 'disabled' : ''}> Permitir Dueto</label>
        <label><input id="tiktok-stitch" type="checkbox" ${info.stitch_disabled ? 'disabled' : ''}> Permitir Costura</label>
      </fieldset>
      <div class="field"><label for="tiktok-commercial">Divulgação comercial</label><select id="tiktok-commercial"><option value="none">Não é conteúdo comercial</option><option value="your_brand">Promove minha marca</option><option value="branded_content" selected>Conteúdo de marca / afiliado</option><option value="both">Minha marca e conteúdo de marca</option></select><small>Como o vídeo contém link de afiliado, “Conteúdo de marca / afiliado” é a opção adequada.</small></div>
      <label class="consent"><input id="tiktok-aigc" type="checkbox" ${mediaKind === 'ai_video' ? 'checked' : ''}> Este conteúdo foi gerado por IA</label>
      <label class="consent"><input id="tiktok-music-consent" type="checkbox"> Ao publicar, concordo com a <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">Confirmação de Uso de Música do TikTok</a>.</label>`;
  } catch (error) {
    panel.innerHTML = `<p class="publication-error">Não foi possível carregar as opções do TikTok: ${escapeHtml(error.message)}</p>`;
  }
}

async function rejectContent(button) {
  const reason = window.prompt('Por que este vídeo foi reprovado?', 'O vídeo não representa fielmente a quantidade e os tipos de peças do produto.');
  if (reason === null) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Reprovando…';
  try {
    const response = await fetch(`/api/content/${encodeURIComponent(button.dataset.id)}/reject`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = 'Vídeo reprovado e bloqueado para publicação. Você pode gerar uma nova versão.';
    await load();
  } catch (error) {
    window.alert(`Não foi possível reprovar: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function startProductGeneration(button) {
  let video;
  try { video = selectedVideoSettings(); } catch (error) { window.alert(error.message); return; }
  const confirmed = await confirmPaidGeneration('Iniciar esta geração?', video);
  if (!confirmed) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add('button-loading');
  button.textContent = 'Iniciando…';
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(button.dataset.productId)}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(video) });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = 'Geração solicitada. O painel acompanhará cada etapa automaticamente.';
    await load();
  } catch (error) {
    window.alert(`Não foi possível iniciar: ${error.message}`);
  } finally {
    button.disabled = false;
    button.classList.remove('button-loading');
    button.textContent = originalLabel;
  }
}

async function retryGeneration(button) {
  let video;
  try { video = selectedVideoSettings(); } catch (error) { window.alert(error.message); return; }
  const confirmed = await confirmPaidGeneration('Tentar novamente? Esta será uma nova operação cobrável.', video);
  if (!confirmed) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add('button-loading');
  button.textContent = 'Reiniciando…';
  try {
    const response = await fetch(`/api/content/${encodeURIComponent(button.dataset.id)}/retry-generation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(video) });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = 'Nova tentativa iniciada com a imagem do produto. O andamento será atualizado automaticamente.';
    await load();
  } catch (error) {
    window.alert(`Não foi possível tentar novamente: ${error.message}`);
  } finally {
    button.disabled = false;
    button.classList.remove('button-loading');
    button.textContent = originalLabel;
  }
}

async function regenerateProduct(button) {
  let video;
  try { video = selectedVideoSettings(); } catch (error) { window.alert(error.message); return; }
  const confirmed = await confirmPaidGeneration('Criar uma nova versão? O vídeo atual será preservado.', video);
  if (!confirmed) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add('button-loading');
  button.textContent = 'Criando versão…';
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(button.dataset.productId)}/regenerate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(video) });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = 'Nova versão solicitada. O vídeo anterior foi preservado.';
    await load();
  } catch (error) {
    window.alert(`Não foi possível gerar outra versão: ${error.message}`);
  } finally {
    button.disabled = false;
    button.classList.remove('button-loading');
    button.textContent = originalLabel;
  }
}

async function showPreview(id) {
  const dialog = $('#preview-dialog');
  $('#preview-body').innerHTML = '<p class="empty" style="padding:22px">Carregando prévia…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(`/api/content/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const item = await response.json();
    let mockVideo = !item.video_url;
    if (item.video_url) {
      try { mockVideo = new URL(item.video_url, window.location.origin).hostname === 'example.invalid'; }
      catch { mockVideo = true; }
    }
    $('#preview-title').textContent = item.product_title;
    const media = mockVideo
      ? `<div class="preview-media"><div class="mock-video"><span class="large-spinner"></span><strong>${activeStatuses.has(item.status) ? 'Vídeo em produção' : 'Vídeo ainda indisponível'}</strong>${escapeHtml(getStatusInfo(item.status).detail)}</div></div>`
      : `<div class="preview-media"><video controls playsinline preload="metadata" src="${escapeHtml(item.video_url)}"></video></div>`;
    const link = item.affiliate_url || item.product_url;
    const canPublishSeparately = ['awaiting_approval', 'qa_passed', 'published'].includes(item.status);
    const publicationByPlatform = new Map((item.publications || []).map((publication) => [publication.platform, publication]));
    const platformDefinitions = [
      { id: 'instagram', label: 'Instagram' },
      { id: 'tiktok', label: 'TikTok' },
      { id: 'youtube', label: 'YouTube' },
    ];
    const lockedPublicationStatuses = new Set(['pending', 'publishing', 'scheduled', 'published', 'uncertain']);
    const selectablePlatforms = platformDefinitions.filter(({ id }) => socialConnections[id] && !lockedPublicationStatuses.has(publicationByPlatform.get(id)?.status));
    const platformChecklist = canPublishSeparately ? `<div class="copy-block approval-destinations"><h3>Destinos da publicação</h3><p class="muted">Escolha agora onde este vídeo será publicado. Os destinos disponíveis vêm selecionados por padrão.</p><div class="approval-platforms">${platformDefinitions.map(({ id, label }) => {
      const publication = publicationByPlatform.get(id);
      const published = publication?.status === 'published';
      const locked = lockedPublicationStatuses.has(publication?.status);
      const connected = Boolean(socialConnections[id]);
      const suffix = published ? ' — já publicado' : publication?.status === 'scheduled' ? ' — agendado automaticamente' : locked ? ' — em andamento' : connected ? '' : ' — não conectado';
      return `<label class="${connected ? '' : 'unavailable'}"><input class="approval-platform" type="checkbox" value="${id}" ${connected && !locked ? 'checked' : ''} ${locked || !connected ? 'disabled' : ''}> ${label}${suffix}</label>`;
    }).join('')}</div></div>` : '';
    const approvalButton = canPublishSeparately && selectablePlatforms.length
      ? `<button id="approve-preview" data-id="${item.id}">${item.status === 'awaiting_approval' ? 'Aprovar e publicar selecionados' : 'Publicar nos destinos selecionados'}</button>`
      : '';
    const tiktokNeedsSettings = canPublishSeparately && selectablePlatforms.some(({ id }) => id === 'tiktok');
    $('#preview-body').innerHTML = `<div class="preview-grid">
      ${media}
      <section class="preview-copy">
        <div class="preview-meta"><span class="tag">Status: ${escapeHtml(item.status)}</span><span class="tag">QA: ${item.qa_score ?? '—'}/100</span><span class="tag">${item.media_kind === 'slideshow' ? 'Fotos: vídeo vertical + carrossel no Instagram' : 'Vídeo por IA'}</span>${item.generation_model ? `<span class="tag">Modelo: ${escapeHtml(item.generation_model)}</span>` : ''}${item.generation_used_credit != null ? `<span class="tag">Custo real: ${escapeHtml(item.generation_used_credit)} crédito(s)</span>` : item.generation_estimated_credit != null ? `<span class="tag">Custo estimado: ${escapeHtml(item.generation_estimated_credit)} crédito(s)</span>` : ''}</div>
        <div class="copy-block"><h3>Gancho</h3><p>${escapeHtml(item.hook || '—')}</p></div>
        <div class="copy-block"><h3>Roteiro</h3><p>${escapeHtml(item.script || '—')}</p></div>
        <div class="copy-block"><h3>Legenda</h3><p>${escapeHtml(item.caption || '—')}</p></div>
        <div class="copy-block"><h3>Chamada para ação</h3><p>${escapeHtml(item.call_to_action || '—')}</p></div>
        <div class="copy-block"><h3>Produto e rastreamento</h3><p>${escapeHtml(item.product_title)} · ${money.format(Number(item.price || 0))}\nID: ${escapeHtml(item.external_id || '—')}\n<a class="preview-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Abrir link oficial do afiliado</a></p></div>
        <div class="copy-block"><h3>Publicações</h3>${publicationDetails(item.publications) || '<p>Nenhuma publicação solicitada.</p>'}</div>
        ${platformChecklist}
        ${tiktokNeedsSettings ? '<div id="tiktok-publish-settings" class="copy-block tiktok-settings"><h3>Opções do TikTok</h3><p class="muted">Carregando as opções atuais da conta…</p></div>' : ''}
        <div class="copy-block"><h3>Observações do QA</h3><p>${escapeHtml(item.qa_notes || 'Nenhuma observação.')}</p></div>
      </section>
    </div><div class="preview-footer"><span class="muted">Nada será publicado apenas por visualizar.</span>${regenerableStatuses.has(item.status) ? `<button id="regenerate-preview" class="secondary" data-product-id="${item.product_id}">Gerar outro vídeo</button>` : ''}${item.status === 'awaiting_approval' ? `<button id="reject-preview" class="secondary" data-id="${item.id}">Reprovar vídeo</button>` : ''}${approvalButton}</div>`;
    const approve = $('#approve-preview');
    if (approve) approve.addEventListener('click', async (event) => { await publishSelectedPlatforms(event.currentTarget); });
    const reject = $('#reject-preview');
    if (reject) reject.addEventListener('click', async (event) => { await rejectContent(event.currentTarget); dialog.close(); });
    const regenerate = $('#regenerate-preview');
    if (regenerate) regenerate.addEventListener('click', async (event) => { await regenerateProduct(event.currentTarget); dialog.close(); });
    if (tiktokNeedsSettings) await loadTikTokPublishingOptions(item.caption, item.media_kind);
  } catch (error) {
    $('#preview-body').innerHTML = `<p class="empty" style="padding:22px">Não foi possível carregar a prévia (${escapeHtml(error.message)}).</p>`;
  }
}

$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
$('#prepare').addEventListener('click', prepareImports);
$('#batch-select-all').addEventListener('change', (event) => document.querySelectorAll('.batch-item').forEach((input) => { input.checked = event.currentTarget.checked; }));
document.querySelectorAll('.batch-platform').forEach((input) => input.addEventListener('change', updateBatchTikTokOptions));
$('#batch-submit').addEventListener('click', publishBatch);
$('#generation-model').addEventListener('change', configureSelectedModel);
['#generation-duration', '#generation-aspect', '#generation-resolution', '#generation-mode'].forEach((selector) => $(selector).addEventListener('change', renderSelectedModelDetails));
$('#run').addEventListener('click', (event) => action(event.currentTarget, '/actions/run-cycle'));
$('#report').addEventListener('click', (event) => action(event.currentTarget, '/actions/send-report'));
$('#connect-tiktok').addEventListener('click', () => { window.location.href = '/api/integrations/tiktok/authorize'; });
$('#connect-youtube').addEventListener('click', () => { window.location.href = '/api/integrations/youtube/authorize'; });
$('#connect-mercado-livre').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/integrations/mercado-livre/authorize-url?brandSlug=achadinhos');
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    $('#finish-mercado-livre').hidden = false;
    if (socialConnections.mercadoLivre) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(result.authorizationUrl);
        copied = true;
      } catch {
        window.prompt('Copie este link e abra-o em uma janela anônima:', result.authorizationUrl);
      }
      pipelineNotice = `${copied ? 'Link de reconexão copiado.' : 'Link de reconexão criado.'} Abra uma janela anônima, cole o link, entre com a nova conta administradora do Mercado Livre e autorize. Depois copie a URL final e clique em “Finalizar conexão”.`;
      window.alert(`${copied ? 'O link de reconexão foi copiado.\n\n' : ''}Abra uma janela anônima (Ctrl+Shift+N), ${copied ? 'cole o link' : 'use o link exibido'}, entre com a NOVA conta do Mercado Livre e autorize.\n\nAo terminar, copie a URL completa da página aberta e volte aqui para clicar em “Finalizar conexão”.`);
    } else {
      const popup = window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
      if (!popup) window.alert('O navegador bloqueou a nova aba. Permita pop-ups e tente novamente.');
      pipelineNotice = `Autorize o Mercado Livre na nova aba. Quando ela abrir ${result.redirectUri}, copie a URL completa e clique em “Finalizar conexão”.`;
    }
    await load();
  } catch (error) { window.alert(`Não foi possível iniciar a conexão: ${error.message}`); }
});
$('#finish-mercado-livre').addEventListener('click', async (event) => {
  const callbackUrl = window.prompt('Cole a URL completa exibida na barra de endereço após autorizar o Mercado Livre:');
  if (!callbackUrl) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/integrations/mercado-livre/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackUrl }) });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    pipelineNotice = 'Conta Mercado Livre conectada. Os próximos links serão verificados na API oficial em busca de vídeos existentes.';
    button.hidden = true;
    await loadConnections();
    await load();
  } catch (error) { window.alert(`Não foi possível concluir a conexão: ${error.message}`); }
  finally { button.disabled = false; }
});
handleTikTokCallbackNotice();
handleYouTubeCallbackNotice();
load(); loadConnections(); loadPublishingLimits(); loadVideoModels(); loadSnapGenAccount().catch(() => {}); setInterval(load, 5000); setInterval(loadConnections, 30000); setInterval(loadPublishingLimits, 300000); setInterval(() => loadSnapGenAccount().catch(() => {}), 60000);
