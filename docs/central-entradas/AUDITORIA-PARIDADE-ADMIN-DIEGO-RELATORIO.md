# Auditoria de paridade — Central de Entradas

SUPER ADMIN, ADMIN e Diego. Diagnóstico somente leitura. Nenhuma correção foi aplicada. Nenhuma consulta ao banco oficial, nenhuma sincronização, manifestação ou chamada à SEFAZ.

Data da auditoria: 31/10/2026.

## Resumo executivo

A Central de Entradas usa **o mesmo código de tela e o mesmo fluxo de carregamento** para qualquer usuário que consiga abrir a página. O que muda é o recorte de dados e um conjunto pequeno de ações administrativas.

A diferença visível para Diego, quando ela existe, vem de três regras reais do código:

1. A página `central-entradas` exige a permissão `compras`, salvo quando `role === 'admin'`. Perfil `ADMIN` ou `SUPER_ADMIN`, sozinho, não abre a Central.
2. Empresas do seletor, do dashboard e da lista vêm de `usuario_empresas` ativo, em modo MULTIEMPRESA. Não há bypass de administrador nessa lista.
3. Diagnóstico, importação de XML legado e habilitar/desabilitar a operação fiscal real ficam ocultos ou desabilitados para quem não é administrador.

Não foi lido o cadastro vivo do usuário Diego. O nome aparece apenas em scripts locais de diagnóstico (`backend/teste_login.js`, `backend/teste_terminal.js`). Esses scripts não foram executados. As conclusões sobre Diego valem para um usuário com `perfil` `USUARIO` e `role` `operador`, que é o modelo que o código aplica a quem não é administrador. Os vínculos reais dele continuam desconhecidos até uma leitura autorizada do cadastro.

ADMIN **não** possui, hoje, todas as permissões do SUPER ADMIN fora das configurações avançadas. A paridade operacional existe quando o ADMIN também tem `role === 'admin'`. Um ADMIN só com `perfil === 'ADMIN'` e `role` operador fica abaixo do que a regra de hierarquia pede.

## Identidades que o código reconhece

| Campo | SUPER ADMIN de referência | ADMIN com `role` admin | ADMIN só de perfil | Diego modelado |
|---|---|---|---|---|
| Como o código o trata | `role` `admin` e `perfil` `SUPER_ADMIN`. É o seed `admin` em `backend/database.js` (~3337), se ainda não existir outro SUPER ADMIN | `role` `admin` e `perfil` `ADMIN` | `role` `operador` e `perfil` `ADMIN` | `role` `operador` e `perfil` `USUARIO` |
| Permissões no login | `finalizarLoginComUsuario` substitui a lista por `PERMISSOES_DISPONIVEIS` porque `role === 'admin'` (`backend/rotas/auth.js` ~191) | Igual ao SUPER ADMIN nesse ponto | A lista gravada em `usuario_permissoes`. O perfil ADMIN não expande a lista | A lista gravada. Sem expansão |
| Identidade na API | `req.user` do JWT: `id`, `usuario_id`, `username`, `nome`, `role`, `perfil`, `permissoes` | Igual | Igual | Igual |
| Empresas na Central | Só vínculos ativos. Perfil não amplia a lista | Igual | Igual | Igual |
| Cadastro vivo nesta auditoria | Não lido | Não lido | Não lido | Não lido. Username `Diego` só em scripts locais |

`UsuarioEmpresaService.listarEmpresasPermitidas` e `exigirEmpresaAutorizada` não consultam `role` nem `perfil`. Administrador sem vínculo ativo não vê a empresa na Central.

## Hierarquia real de permissões

Simulação isolada de `frontend/shared/js/access-control.js`, sem banco e sem sessão real.

| Capacidade | SUPER ADMIN (`role` admin) | ADMIN (`role` admin, perfil ADMIN) | ADMIN (perfil ADMIN, `role` operador, sem `compras`) | Diego com `compras` | Diego sem `compras` |
|---|---|---|---|---|---|
| Abrir a Central | Sim | Sim | Não | Sim | Não |
| Diagnóstico da Central | Sim | Sim | Sim | Não | Não |
| Tela de usuários | Sim | Sim | Não | Não | Não |
| Configurações avançadas | Sim | Não | Não | Não | Não |
| Abrir o ERP | Sim | Sim | Sim | Sim | Não |
| `podeGerenciarUsuariosSistema` | Sim | Sim | Não | Não | Não |

A função `usuarioTemPermissao` (`access-control.js` ~233) decide nesta ordem:

1. Diagnóstico: `role` admin ou perfil `SUPER_ADMIN`, `ADMIN` ou `SUPORTE`.
2. Usuários: somente `role === 'admin'`. Perfil ADMIN não entra.
3. Configurações avançadas e páginas irmãs: somente `perfil === 'SUPER_ADMIN'`, **antes** do atalho de `role` admin.
4. Qualquer outra página, inclusive a Central: `role === 'admin'`, senão a chave de `PERMISSOES_PAGINAS`. A Central usa a chave `compras` (linha 16).

No backend:

- `exigirAdmin` (`backend/middleware/auth.js` ~115): `role` admin **ou** perfil `ADMIN` **ou** `SUPER_ADMIN`.
- `exigirSuperAdmin` (~130): somente `perfil === 'SUPER_ADMIN'`. `role` admin com perfil ADMIN é recusado.
- `exigirDiagnosticoCentral` (~169): `role` admin ou perfil `SUPER_ADMIN`, `ADMIN` ou `SUPORTE`.
- `GET /api/auth/usuarios` (~556): só `verificarToken`. Qualquer sessão autenticada lista usuários e permissões.
- Criar e editar usuário: `exigirAdmin`. Desativar, ativar e excluir: `exigirSuperAdmin`.

Resposta direta à hierarquia pedida: **não**. O ADMIN só empata com o SUPER ADMIN nas funções operacionais quando também tem `role` admin. Configurações avançadas estão bloqueadas na tela e nas rotas de gravação (`GET /`, `POST /` e `PUT /padrao-fiscal` em `backend/rotas/configuracoes_avancadas.js`). Vários GET de leitura dessa mesma rota (`/confirmacao-fiscal`, `/recursos`, `/contrato-operacional`, `/pdv-modelo-empresa`, `/padrao-fiscal`) não chamam `exigirSuperAdmin`. O router inteiro só exige token (`backend/server.js` ~247).

## Por que a Central fica diferente para Diego

A implementação da página é uma só: `loadCentralEntradas` em `frontend/erp/js/central-entradas.js`. Não há ramo “se for Diego” nem “se for administrador” no carregamento de dashboard e documentos.

O que o código faz de forma diferente:

| O que Diego vê | Causa no código | Legítimo? |
|---|---|---|
| A página nem abre | Sem `role` admin e sem permissão `compras` | Legítimo se ele não deve operar compras. Defeito se a Central deveria ser independente de `compras` |
| Menos empresas no seletor | `GET /api/empresas/contexto/disponiveis` devolve só vínculos ativos | Legítimo |
| Dashboard e lista menores | `resolverLeituraCentral` recorta `empresaIds` do usuário | Legítimo |
| Menu Diagnóstico e Importação de XML legado ausentes | `usuarioPodeAcessarDiagnosticoCentral` no cabeçalho (~1432 e ~1474) | Legítimo |
| Botões de habilitar operação fiscal real desabilitados | `usuarioPodeAdminOperacaoFiscalReal` (~2456) | Legítimo |
| Botão Sincronizar, filtros, abas e lista presentes | Não dependem de perfil | A experiência operacional é a mesma função |
| “0 empresas” ou lista vazia | Usuário autenticado sem vínculo, em MULTIEMPRESA | Legítimo como ausência de empresa, não como erro de perfil |
| Empresa de outro usuário recusada | `EMPRESA_NAO_AUTORIZADA` 403 | Legítimo |

Mensagens que não devem ser confundidas:

- Sem empresa individual e vista não consolidada: a tela pede seleção e não chama dashboard.
- Lista confirmada vazia: estado vazio, visão consolidada, sem `EMPRESA_CENTRAL_AUSENTE`.
- Falha de `/empresas/contexto/disponiveis`: “empresas indisponíveis”, lista zerada, sem reutilizar a sessão anterior.
- Empresa de outro usuário: 403 `EMPRESA_NAO_AUTORIZADA`.

## Matriz de funcionalidades

Confirmada no código e na simulação. “Total” do SUPER ADMIN na Central ainda depende dos vínculos empresariais.

| Funcionalidade | SUPER ADMIN | ADMIN com `role` admin | Diego com `compras` | Diego sem `compras` |
|---|---|---|---|---|
| Dashboard, indicadores operacionais e documentos | Mesmo fluxo. Dados dos vínculos | Igual | Igual, nos vínculos dele | Página bloqueada no frontend |
| Alertas e pendências da inteligência | Mesmo fluxo, hoje sem filtro de empresa | Igual | Igual, e por isso pode ver alerta global | API ainda acessível com token |
| Gestão de usuários na tela | Sim | Sim | Não | Não |
| Criar usuário pela API | Sim | Sim (`exigirAdmin`) | Não | Não |
| Desativar ou excluir usuário | Sim | Não, se o perfil não for SUPER ADMIN | Não | Não |
| Listar usuários pela API | Sim | Sim | Sim, hoje qualquer token | Sim |
| Listar todas as empresas pela API | Sim | Sim | Sim, `GET /api/empresas` não filtra vínculo | Sim |
| Seletor da Central | Só vínculos | Só vínculos | Só vínculos | Não chega à tela |
| Sincronização HTTP | Empresa do vínculo | Igual | Igual | A rota exige empresa autorizada |
| Configurações avançadas | Permitido | Bloqueado na tela e na gravação | Bloqueado | Bloqueado |
| Configurações operacionais da Central | Mesma tela de configuração | Igual | Igual | Página bloqueada |
| Diagnóstico e XML legado | Visível | Visível | Oculto | Oculto |
| Habilitar DistDFe real | Permitido | Permitido | Botão desabilitado e API 403 | Idem |

## Matriz de endpoints da Central

Montagem: `app.use('/api/central-entradas', verificarToken, exigirRecurso('fiscal'), …)` em `backend/server.js` ~279. `exigirRecurso('fiscal')` é licença da instalação, igual para todos os usuários.

Identidade: `verificarToken` grava `req.user` (`backend/middleware/auth.js` ~86). Vários handlers ainda leem `req.usuario`, que o middleware **não** define. Onde isso acontece, o id do usuário autenticado se perde e o body pode preencher o buraco.

| Rota | Permissão extra | Empresa | Divergência |
|---|---|---|---|
| `GET /dashboard`, `/operacional`, `/indicadores-fiscais`, `/inteligencia`, `GET /` | Token | `resolverLeituraCentral`. Individual exige vínculo. `escopo=todas` usa só as empresas do `req.user` | Mesmo contrato para os três perfis. Formato igual |
| `POST /sincronizar` e `POST /sincronizar-ao-abrir` | Token | `resolverEmpresaParaCentral` + vínculo. Não é visão consolidada | Igual para quem tem a empresa |
| `GET /saude`, `/saude/alertas`, período padrão, buscar chave, operação fiscal real | Token. Habilitar/desabilitar/fila ainda exigem perfil admin no serviço | Empresa individual + vínculo | Diego recebe 403 só na ação administrativa |
| Documento por id, histórico, XML, parse, score, processar, revisar | `comDocumentoAutorizado` | Documento da empresa do contexto | Igual |
| `PATCH /:id/status` | Administrador em `alterarStatusManual` (~991) | Documento autorizado | Diego recebe 403. Legítimo |
| Diagnóstico, importar XML legado, recuperar XML executar | `exigirDiagnosticoCentral` | Parte das ações também resolve empresa | Diego recebe 403. Legítimo |
| `GET /alertas`, `GET /pendencias` | Só token | Nenhuma | **Defeito.** `listarAlertas` não filtra `empresa_id` |
| `GET /inteligencia` | Token + leitura | A rota filtra, mas `obterInteligenciaOperacional` (~850) chama `listarAlertas()` sem empresa. Indicadores operacionais recebem `empresaId` | Alertas, pendências e atenção podem misturar empresas. Contadores do dashboard, não |
| `GET /config`, `PATCH /config`, várias rotas `/configuracao` | Token | Não unificado nesta auditoria como vínculo | Configuração global acessível a Diego se a tela estiver aberta |
| `GET /metadados`, `/feature-flags` | Token | Não | Igual. Não carrega documento |
| `POST /upload` | Token | O serviço aceita `req`, mas a rota (~1061) não envia `req` | **Defeito.** Sem `req`, o vínculo não é exigido |
| `GET /eventos`, `/notificacoes`, `/homologacao/painel`, `/fornecedor/:cnpj/estatisticas` | Token | Não passam pelo resolvedor de empresa | Escopo global ou por CNPJ, não por vínculo |
| Schedulers | Sem sessão | Todas as empresas ativas, ou candidatos sem `empresaId` | Autorização sistêmica, não de usuário |

## Carregamento da interface

O mesmo para SUPER ADMIN, ADMIN e Diego, depois que a página é permitida.

1. `CdsEmpresaContexto.inicializar` busca `GET /empresas/contexto/disponiveis`.
2. Id guardado que não está na lista do usuário é descartado. Falha da API também limpa o contexto.
3. Login, `handleUnauthorized` e a saída para `/login` por módulo negado apagam `cds_empresa_id` e `cds_empresa`.
4. A Central associa `empresasPermitidas` ao id do usuário. Troca de usuário zera a lista antes de buscar de novo.
5. Vista individual sem empresa não chama dashboard nem documentos.
6. Vista “Todas as empresas” chama leitura com `escopo=todas` e sem `X-Empresa-Id`.
7. Troca de empresa pelo seletor ou pela barra recarrega dashboard e documentos.
8. O que some para Diego: item Diagnóstico, importação de XML legado, e os botões de habilitar, desabilitar e liberar fila da operação real. Sincronizar, adicionar XML, filtros, abas e a grade permanecem.

Não há CSS separado por perfil.

## Contexto empresarial e multiempresa

`resolverEmpresaParaCentral` (`CentralEntradasEmpresaContextoService.js` ~111):

- **EMPRESA_SIMPLES:** devolve a empresa operacional do contrato e **não** consulta `usuario_empresas`. O header é ignorado. Isso é intencional no contrato de uma empresa só. Não é seguro se Diego deveria ficar fora dessa empresa: qualquer token autenticado opera nela.
- **MULTIEMPRESA:** empresa do header, do `req.empresaId` ou do CNPJ. Se `req` existe, `exigirEmpresaAutorizada(req.user)` exige vínculo ativo e empresa ativa. Sem `req`, o vínculo não é reavaliado. Upload usa esse caminho.

`resolverLeituraCentral` só nas cinco leituras consolidadas. `escopo=todas` em MULTIEMPRESA não exige `X-Empresa-Id` e limita `empresaIds` ao usuário. Lista vazia não vira `EMPRESA_CENTRAL_AUSENTE`. EMPRESA_SIMPLES ignora `todas` e fica na empresa do contrato.

`listarAlvosSincronizacaoCentral` lista a empresa operacional, ou todas as empresas ativas. Não recebe usuário. Os POST HTTP de sincronização não usam essa lista solta: passam a empresa já autorizada. O agendamento interno usa a lista completa.

Não há fallback para empresa `1` nesses resolvedores. A empresa padrão da interface é a matriz marcada em `empresaPadrao`, senão a primeira da lista **daquele usuário**.

O formato JSON de dashboard e lista é o mesmo. Mudam `empresaId`, `visao` e os ids autorizados.

## Schedulers

Não foram iniciados.

| Componente | Seleção | Usuário | Isolamento |
|---|---|---|---|
| `CentralSyncBackgroundService` ~360 | `executarSincronizacao` sem `empresaId` | Nenhum. Origem `BACKGROUND` | Percorre alvos ativos. SOAP DistDFe continua dependente de operação real e gate por empresa. Log traz `correlationId` |
| `CentralManifestacaoScheduler.executarCiclo` ~141 | `processarCandidatos` sem `empresaId` | Nenhum. Origem `scheduler` | Seleção global de candidatos. Log de ciclo, sem usuário |
| `CentralXmlWaitScheduler` | Delega ao motor de espera de XML | Nenhum | Não foi aberto ciclo |
| Pós-sync HTTP | Quando a rota manda `empresaId`, processamento e candidatos ficam nessa empresa | `req.user.id` | Isolado na chamada HTTP. O job interno não |

A ausência de usuário no scheduler é tratada como execução de sistema, não como erro. O risco é operar empresa que nenhum operador da estação deveria alcançar, se a operação real estiver habilitada nela.

## Evidências dos testes isolados

Ambiente: funções reais de permissão em sandbox e leitura do código das rotas. Sem `mercadao.db`, sem SEFAZ, sem scheduler.

- SUPER ADMIN simulado: Central, diagnóstico, usuários e configurações avançadas permitidos.
- ADMIN com `role` admin: Central, diagnóstico e usuários permitidos. Configurações avançadas negadas.
- ADMIN só de perfil, sem `compras`: ERP permitido pelo perfil, Central negada, tela de usuários negada.
- Diego com `compras`: Central permitida, diagnóstico, usuários e configurações avançadas negados.
- Diego sem `compras`: Central e ERP negados.
- Regras de vínculo da Sprint 20B e de sincronização da Sprint 20C permanecem: empresa de outro usuário é 403; visão consolidada não usa empresa de outro usuário; sincronização HTTP exige empresa individual. Esses testes não foram reexecutados contra o banco oficial nesta auditoria. A evidência deles está nos arquivos `tests/central-entradas/cds-central-contexto-usuario-20b.test.js` e `cds-central-sincronizacao-sessao-20c.test.js`.

O cadastro real de Diego, do administrador e dos vínculos **não** foi comprovado. É hipótese, não fato, que o Diego da estação seja `USUARIO` com ou sem `compras`, e que o administrador visto na tela seja o seed `role` admin + `SUPER_ADMIN`.

## Divergências

### P0 — segurança

1. **Alertas e pendências sem empresa.** `CentralAlertasService.listarAlertas` (~28) e `listarFornecedoresNovos` (~738) não filtram `empresa_id`. `GET /alertas` e `GET /pendencias` não resolvem empresa. `obterInteligenciaOperacional` (~850) reutiliza esses alertas mesmo quando a rota já calculou `empresaIds`. Consequência: Diego e o administrador podem ver alertas de empresas fora do vínculo. Correção: passar `empresaId` ou `empresaIds` já autorizados para alertas, pendências e atenção.

2. **Upload sem o `req` autenticado.** `POST /upload` (~1061) não chama o resolvedor. `CentralUploadService` (~123) só valida vínculo se receber `req`. A rota não envia. Consequência: XML cujo CNPJ casa com uma empresa ativa pode entrar sem vínculo do usuário. Correção: passar `req` e exigir o mesmo resolvedor das outras operações individuais.

3. **`GET /api/empresas` lista todas as empresas** (`backend/rotas/empresas.js` ~174) para qualquer token. O seletor da Central está correto. A API de cadastro não. Correção: listar pelo mesmo `listarEmpresasPermitidas`, e reservar a lista completa a quem administra empresas.

4. **`GET /api/auth/usuarios` sem perfil** (`auth.js` ~556). Qualquer sessão lê usuários e permissões. Correção: `exigirAdmin` alinhado à regra de gestão de usuários.

### P1 — função essencial ou hierarquia

5. **ADMIN de perfil não tem a paridade pedida.** Login só expande permissões se `role === 'admin'` (`auth.js` ~191). A Central exige `compras` mesmo com perfil ADMIN. A tela de usuários exige `role === 'admin'`, enquanto a API de criar usuário aceita perfil ADMIN. Desativar e excluir usuário exigem SUPER ADMIN. Correção: uma função única de “administrador operacional” usada no login, no frontend e no backend, sem incluir configurações avançadas e sem promover Diego.

6. **GET de configurações avançadas sem `exigirSuperAdmin`.** A tela bloqueia. Parte da API não. Correção: o mesmo `exigirSuperAdmin` em todas as rotas desse router.

7. **EMPRESA_SIMPLES ignora vínculo** (`resolverEmpresaParaCentral` ~117). Intencional para uma empresa operacional. Inseguro se algum usuário da estação não deve operar essa empresa. Correção: decidir na regra de produto se o modo simples também exige vínculo. Não alterar até essa decisão.

### P2 — interface e carregamento

8. **Inteligência mistura número filtrado e alerta global.** Os cards do `GET /dashboard` seguem o escopo. Alertas da inteligência, não. Diego numa empresa só pode ver indicadores “de todas”. Correção: a mesma do item 1.

9. **A Central depende da permissão `compras`.** Quem tem fiscal e não tem compras não entra. Pode parecer bloqueio de perfil. Correção: permissão própria da Central, se a regra de negócio for essa.

### P3 — secundário

10. **`req.usuario` em rotas de XML legado e portal nacional** (`central-entradas.js`, vários `req.usuario?.id`). O middleware não define `req.usuario`. O id cai para o body. Não muda a tela. Correção: usar só `req.user`.

11. **Scheduler sem usuário** é desenho atual, não falha da sessão do Diego. Registrar empresa e origem em todo ciclo já parcialmente existe. Não executar empresa fora da política sistêmica quando a operação real estiver ligada.

## Causas confirmadas e hipóteses

Confirmado no código e na simulação:

- Mesma implementação de tela e de dashboard/documentos.
- Recorte de empresas por vínculo, sem privilégio automático de admin.
- Ações de diagnóstico e de DistDFe real dependem de perfil.
- A página depende de `compras` ou de `role` admin.
- ADMIN de perfil não equivale ao SUPER ADMIN.
- Configuração avançada de gravação está restrita ao SUPER ADMIN.
- Alertas globais, upload sem `req`, lista geral de empresas e lista geral de usuários furam o isolamento.

Não comprovado, porque o banco oficial não foi lido:

- Perfil, role, permissões e empresas reais do Diego e do administrador da estação.
- Se o modo em produção é EMPRESA_SIMPLES ou MULTIEMPRESA.
- Se o sintoma visto na estação é página negada, seletor menor, ou alerta de outra empresa.

## Plano de correção, sem implementar

1. Escopar alertas, pendências e atenção pela empresa já autorizada na leitura.
2. Fazer o upload receber `req` e o resolvedor com vínculo.
3. Fechar `GET /usuarios` e `GET /empresas` na autorização que já existe para o restante do cadastro.
4. Aplicar `exigirSuperAdmin` aos GET abertos de configurações avançadas.
5. Unificar a hierarquia ADMIN × SUPER ADMIN numa função só, preservando o bloqueio de configurações avançadas e sem conceder esse papel a Diego.
6. Só depois, decidir se EMPRESA_SIMPLES também exige vínculo.
7. Revisar o scheduler apenas para não ampliar empresa quando a operação real estiver ativa.

Cada item é uma sprint pequena. Nenhuma foi iniciada.

## Respostas objetivas

1. **ADMIN tem todas as permissões do SUPER ADMIN, exceto configurações avançadas?** Não, se o ADMIN não tiver `role` admin. Com `role` admin e perfil ADMIN, a tela operacional fica equivalente e as configurações avançadas ficam bloqueadas. Desativar e excluir usuário continuam só no SUPER ADMIN. Vários GET avançados seguem abertos.
2. **Configurações avançadas bloqueadas no backend?** Gravação e o GET principal, sim. Leituras auxiliares, não.
3. **Por que Diego é diferente?** A página e os dados dependem de `compras` e de vínculos, e o menu administrativo depende de perfil. Não há uma Central paralela para ele.
4. **O que é legítimo?** Menos empresas, diagnóstico oculto, DistDFe real desabilitado, configurações avançadas negadas. **O que é defeito?** Alertas sem empresa, upload sem vínculo, listas globais de usuários e empresas, e ADMIN de perfil sem a paridade operacional.
5. **O fluxo da Central é o mesmo?** Sim, para quem abre a página. Dashboard e documentos usam as mesmas funções. O escopo muda pelo vínculo.
6. **O isolamento multiempresa está correto?** Nas leituras individuais, na visão consolidada e na sincronização HTTP, sim, em MULTIEMPRESA. Não está correto em alertas, upload sem `req`, `GET /empresas` e no modo EMPRESA_SIMPLES sem vínculo.
7. **Há bloqueio indevido por perfil, cache ou contexto?** O bloqueio de diagnóstico e de DistDFe real é proposital. O bloqueio da Central inteira para um ADMIN sem `compras` e sem `role` admin é indevido frente à hierarquia pedida. O cache da Central está amarrado ao usuário desde a Sprint 20B. O contexto anterior é limpo no login, na sessão inválida e na saída para `/login`.
8. **Sequência mínima segura:** itens 1 a 4 do plano, depois a hierarquia, por último a decisão do modo simples. Não promover Diego a administrador para igualar a tela.
