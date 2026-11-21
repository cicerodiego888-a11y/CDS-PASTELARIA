(function () {
  'use strict';

  const acesso = document.getElementById('tv-acesso');
  const login = document.getElementById('tv-login');
  const empresaForm = document.getElementById('tv-empresa');
  const empresaSelect = document.getElementById('tv-empresa-selecao');
  const mensagem = document.getElementById('tv-mensagem');
  const alerta = document.getElementById('tv-alerta');
  const sair = document.getElementById('tv-sair');
  const host = document.getElementById('page-content');
  const contexto = window.CdsEmpresaContexto;
  let geracao = 0;

  function limparSessao() {
    geracao += 1;
    if (window.CdsCozinhaKds) window.CdsCozinhaKds.parar();
    window.CdsCozinhaKds = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    contexto.limpar();
    host.innerHTML = '';
    acesso.hidden = false;
    login.hidden = false;
    empresaForm.hidden = true;
    sair.hidden = true;
  }

  async function listarEmpresas() {
    const atual = geracao;
    mensagem.textContent = 'Carregando empresas...';
    const empresas = await contexto.listarDisponiveis();
    if (atual !== geracao) return;
    if (!Array.isArray(empresas) || !empresas.length) {
      throw new Error('Nenhuma empresa disponível para este usuário.');
    }
    empresaSelect.replaceChildren();
    const selecionada = contexto.lerEmpresaId();
    empresas.forEach((empresa) => {
      const option = document.createElement('option');
      option.value = String(empresa.id);
      option.textContent = empresa.nome_fantasia || empresa.razao_social || `Empresa #${empresa.id}`;
      if (Number(empresa.id) === selecionada) option.selected = true;
      empresaSelect.appendChild(option);
    });
    mensagem.textContent = '';
    login.hidden = true;
    empresaForm.hidden = false;
    sair.hidden = false;
  }

  login.addEventListener('submit', async (event) => {
    event.preventDefault();
    const atual = geracao;
    const botao = login.querySelector('button');
    botao.disabled = true;
    mensagem.textContent = 'Autenticando...';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('tv-usuario').value.trim(),
          password: document.getElementById('tv-senha').value
        })
      });
      const data = await response.json();
      if (atual !== geracao) return;
      if (!response.ok) throw new Error(data.error || data.mensagem || 'Falha ao autenticar.');
      if (!data.token || !data.user) throw new Error('Resposta de autenticação inválida.');
      if (data.troca_senha_obrigatoria || data.user.troca_senha_obrigatoria) {
        throw new Error('Altere a senha no computador antes de acessar a cozinha na TV.');
      }
      contexto.limpar();
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      document.getElementById('tv-senha').value = '';
      await listarEmpresas();
    } catch (err) {
      if (atual === geracao) mensagem.textContent = err.message || 'Falha ao autenticar.';
    } finally {
      botao.disabled = false;
    }
  });

  empresaForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const atual = geracao;
    const botao = empresaForm.querySelector('button');
    botao.disabled = true;
    mensagem.textContent = 'Selecionando empresa...';
    try {
      const resposta = await fetch('/api/empresas/contexto', {
        method: 'POST',
        headers: contexto.headersJson(),
        body: JSON.stringify({ empresaId: Number(empresaSelect.value) })
      });
      const dados = await resposta.json();
      if (atual !== geracao) return;
      if (!resposta.ok) throw new Error(dados.error || dados.erro || 'Falha ao selecionar empresa.');
      if (!dados.empresa || Number(dados.empresa.id) !== Number(empresaSelect.value)) {
        throw new Error('Resposta da empresa selecionada inválida.');
      }
      contexto.persistir(dados.empresa);
      acesso.hidden = true;
      mensagem.textContent = '';
      await window.loadCozinhaKds({ unidadeJwt: 0 });
    } catch (err) {
      if (atual === geracao) {
        acesso.hidden = false;
        mensagem.textContent = err.message || 'Falha ao abrir a cozinha.';
      }
    } finally {
      botao.disabled = false;
    }
  });

  sair.addEventListener('click', () => {
    limparSessao();
    mensagem.textContent = '';
  });
  document.getElementById('tv-tela-cheia').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else throw new Error('Tela cheia não disponível neste navegador.');
    } catch (err) {
      alerta.textContent = err.message || 'Não foi possível ativar tela cheia.';
    }
  });

  if (localStorage.getItem('token')) {
    const atual = geracao;
    listarEmpresas().catch((err) => {
      if (atual !== geracao) return;
      if (err.status === 401 || err.status === 403) limparSessao();
      mensagem.textContent = err.message || 'Não foi possível carregar as empresas.';
    });
  }
}());
