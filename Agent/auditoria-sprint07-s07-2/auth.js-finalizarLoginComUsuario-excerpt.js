function finalizarLoginComUsuario(req, res, usuario) {
  buscarPermissoesUsuario(usuario.id, (errPerm, permissoes) => {
    if (errPerm) {
      return responderErroInternoLogin(res, 'ERRO PERMISSÕES', errPerm);
    }

    if (usuario.role === 'admin') {
      permissoes = PERMISSOES_DISPONIVEIS;
    }

    const terminalId = parsePositiveInteger(req.body?.terminal_id);
    const caixaSessaoId = parsePositiveInteger(req.body?.caixa_sessao_id);
    const unidadeCozinhaIdRaw = req.body?.unidade_cozinha_id != null
      ? req.body.unidade_cozinha_id
      : req.body?.unidadeCozinhaId;
    const empresaIdSessaoRaw = req.body?.empresa_id != null
      ? req.body.empresa_id
      : req.body?.empresaId;

    const emitirToken = (unidadeCozinhaId, extraDetalhe = {}) => {
      try {
        const token = jwt.sign(
          {
            id: usuario.id,
            usuario_id: usuario.id,
            username: usuario.username,
            nome: usuario.nome || usuario.username,
            role: usuario.role,
            perfil: usuario.perfil || 'USUARIO',
            permissoes,
            terminal_id: terminalId,
            caixa_sessao_id: caixaSessaoId,
            unidade_cozinha_id: unidadeCozinhaId
          },
          JWT_SECRET,
          { expiresIn: '8h' }
        );

        res.json({
          token,
          user: {
            id: usuario.id,
            usuario_id: usuario.id,
            username: usuario.username,
            role: usuario.role,
            perfil: usuario.perfil || 'USUARIO',
            nome: usuario.nome || usuario.username,
            permissoes,
            terminal_id: terminalId,
            caixa_sessao_id: caixaSessaoId,
            unidade_cozinha_id: unidadeCozinhaId,
            troca_senha_obrigatoria: Number(usuario.troca_senha_obrigatoria) === 1
          },
          troca_senha_obrigatoria: Number(usuario.troca_senha_obrigatoria) === 1
        });

        gravarAuditoria({
          usuario_id: usuario.id,
          usuario_nome: usuario.username,
          modulo: 'auth',
          acao: 'login',
          referencia_tipo: 'usuario',
          referencia_id: usuario.id,
          detalhes: {
            ip: req.ip,
            username: usuario.username,
            unidade_cozinha_id: unidadeCozinhaId,
            ...extraDetalhe
          },
          ip_requisicao: req.ip || null
        }).catch((auditErr) => {
          console.error('Erro ao gravar auditoria de login:', auditErr);
        });
      } catch (tokenErr) {
        responderErroInternoLogin(res, 'ERRO TOKEN', tokenErr);
      }
    };

    const concluirLogin = (extraDetalhe = {}) => {
      // Valida unidade no cadastro ANTES de assinar o JWT (não confia no body).
      validarUnidadeCozinhaNoLogin({
        db,
        usuario,
        unidadeCozinhaIdRaw,
        empresaIdRaw: empresaIdSessaoRaw
      })
        .then((unidadeValidada) => {
          emitirToken(unidadeValidada, {
            ...extraDetalhe,
            unidade_cozinha_validada: unidadeValidada != null
          });
        })
        .catch((errUnidade) => {
          const status = errUnidade.statusCode || 403;
          const codigo = errUnidade.codigo || 'UNIDADE_NAO_AUTORIZADA';
          if (status >= 500) {
            return responderErroInternoLogin(res, 'ERRO UNIDADE COZINHA', errUnidade);
          }
          return res.status(status).json({
            success: false,
            error: errUnidade.message || 'Unidade de cozinha não autorizada.',
            mensagem: errUnidade.message || 'Unidade de cozinha não autorizada.',
            codigo
          });
        });
    };

    // Garante vínculo empresarial mínimo antes de qualquer módulo (PDV/ERP/Caixa).
    UsuarioEmpresaService.garantirAcessoEmpresarialMinimo(usuario, { db, user: usuario })
      .then((acesso) => {
        concluirLogin({
          empresas_disponiveis: Array.isArray(acesso.empresas) ? acesso.empresas.length : 0,
          empresas_vinculo_auto: !!acesso.healed
        });
      })
      .catch((errAcesso) => {
        console.error('Falha ao garantir acesso empresarial no login:', errAcesso);
        // Login não bloqueia por falha de vínculo; o seletor ainda tentará curar.
        // Unidade, se solicitada, ainda é validada em concluirLogin.
        concluirLogin({ empresas_vinculo_erro: errAcesso && errAcesso.message });
      });
  });
}


