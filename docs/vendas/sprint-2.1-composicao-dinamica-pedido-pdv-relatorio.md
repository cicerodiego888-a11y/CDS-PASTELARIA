# Sprint — Composição dinâmica do Pedido → PDV

## Resultado

A composição passou a cotar os pastéis pelo preço vigente do catálogo usando `CotacaoPrecoProdutoService`; o valor de R$ 8,99 deixou de ser constante no motor. Refrigerantes só são elegíveis quando o volume comercial, convertido pela autoridade MUC, resulta em 200, 300 ou 500 ml.

A busca preserva a prioridade de composição exata. Quando ela não existe, procura o menor total válido acima do residual e registra a diferença como desconto global explícito. O preço unitário cotado não é alterado para encaixar o total. A preparação continua sem venda parcial ou movimentação de estoque.

## Causa corrigida

- `PedidoPdvComposicaoService` usava R$ 8,99 fixos para todos os pastéis e bloqueava qualquer composição sem fechamento exato.
- Os refrigerantes eram aceitos por volume convertido, mas não havia a restrição explícita aos três volumes comerciais aprovados.
- A composição não transportava um desconto de sobrevalor para o PDV.
- O mapeamento em centavos descartava frações de centavo do preço unitário em alguns cenários, embora o cotador oficial arredonde o subtotal da linha. O preço unitário cotado agora é preservado e o subtotal continua validado em centavos.

## Contrato implementado

1. Pastéis elegíveis do Pedido são cotados na referência temporal da composição pelo serviço de cotação, usando o modo regular que lê `produtos.preco_venda` e aplica as regras vigentes desse serviço.
2. A quantidade vem das linhas persistidas do Pedido; o subtotal de cada linha é validado em centavos.
3. O motor tenta primeiro o valor residual exato. Se não fechar, busca o menor subtotal válido acima do residual. Se o limite de estados for atingido, ou não houver candidato acima, bloqueia a preparação em vez de declarar um resultado incompleto.
4. O resultado preserva `valorCompostoBrutoCentavos`, `descontoCentavos` e `valorFinalCentavos`. A igualdade exigida é `bruto - desconto = total persistido do Pedido`.
5. A rota persiste o valor bruto e o desconto no snapshot da operação. O PDV carrega o desconto no campo global já existente, confere os totais em centavos e zera acréscimos para que não alterem o total do Pedido.
6. Descontos positivos continuam sujeitos à autorização de administrador/supervisor já exigida pelo fluxo de venda. Não houve bypass de autorização nem mudança do Motor Fiscal.

## Evidência com os fixtures SQLite em memória

- **Fechamento exato:** 2 pastéis a R$ 8,99 = R$ 17,98; refrigerante elegível de R$ 12,99; total de R$ 30,97; desconto zero.
- **Menor excedente:** para Pedido de R$ 61,98, os pastéis somam R$ 17,98 e deixam R$ 44,00. A menor combinação encontrada acima é 2 × R$ 12,99 + 1 × R$ 19,80 = R$ 45,78. Total bruto = R$ 63,76; desconto explícito = R$ 1,78; total líquido = R$ 61,98.
- **Preço dinâmico:** ao alterar o preço do pastel no fixture de R$ 8,99 para R$ 9,50 sem alterar código, o subtotal de duas unidades mudou de R$ 17,98 para R$ 19,00 e o residual foi recalculado.
- **Frações de centavo:** preço unitário de R$ 12,995 preservado; duas unidades resultam no subtotal de R$ 25,99.
- Foram cobertos volumes de 200, 300 e 500 ml, conversão MUC de volume, rejeição de volume fora da regra, disponibilidade, repetição sem movimento de estoque, empate, impossibilidade de composição acima e limite de busca inconclusivo.

Os valores acima são resultados dos fixtures automatizados, não uma homologação do catálogo operacional atual.

## Arquivos desta implementação

- `backend/services/vendas/PedidoPdvComposicaoService.js` — preço dinâmico do pastel, filtro de volume, escolha exata/menor excedente, cálculo do desconto e fingerprint.
- `backend/services/vendas/ComposicaoFiscalPedidoService.js` — objetivo opcional de menor total acima, mantendo o comportamento padrão dos demais chamadores e o bloqueio por limite inconclusivo.
- `backend/services/vendas/CotacaoPrecoProdutoService.js` — exposição do limite superior seguro do preço cotado para delimitar a busca sem duplicar as regras de preço.
- `backend/rotas/pedidos.js` — persistência e recuperação do desconto e do bruto no snapshot da operação.
- `frontend/pdv/js/pdv.js` — validação e carregamento do desconto no handoff, sem acréscimo residual.
- `tests/vendas/pedido-pdv-composicao.test.js` — regressões de composição, preço dinâmico, centavos, volume, disponibilidade, excedente e busca inconclusiva.
- `tests/faturamento/sprint35-pedidos-ui.test.js` — verificação do transporte do desconto no handoff.

## Validação executada

- `node --check` nos serviços, rota e script do PDV alterados.
- Suítes de composição, cotação, integração, multiempresa e interface Pedido–PDV: **80 passaram; 0 falharam**.
- `tests/vendas/sprint-2-5-limites-desempenho-saldos.test.js`: **17 passaram; 0 falharam**, incluindo busca contra força bruta e limite de estados.
- `git diff --check`: passou; apenas avisos de normalização CRLF/LF em arquivos preexistentes.
- Os cenários desta implementação usam SQLite em memória ou fixtures de teste. Nenhuma alteração foi feita no banco operacional.

## Limites de homologação

Não houve execução no Electron, finalização de pagamento, emissão de documento fiscal, conferência do estoque físico/ledger ou autorização de desconto por operador real. Também não foi feita nova consulta ao catálogo operacional neste ciclo. A regra do desconto está integrada ao contrato existente, mas seu uso efetivo depende de autorização de supervisor conforme a política atual. Portanto, os testes automatizados aprovam o código focal; a homologação operacional do PDV e do ciclo fiscal/estoque permanece pendente.

## Atualização — homologação operacional, 25/10/2026

### Versão e ambiente ativo

- No início da inspeção não havia processo Electron nem backend escutando nas portas 3001/3191.
- O `package.json` do workspace declara versão `1.0.3`; o Electron instalado no workspace é `22.3.27`.
- O build ERP disponível é de 16/09/2026. Seu `app.asar` corresponde ao hash declarado no `electron-build-manifest.json` (`0F31F733…C71CD`). O build PDV disponível é de 22/07/2026.
- Os arquivos `PedidoPdvComposicaoService.js` não constam nos arquivos dos dois `app.asar`. Portanto, esses pacotes não contêm a composição dinâmica atual e não servem para homologar esta alteração.

### Smoke do Electron de desenvolvimento

Foi iniciado o Electron de desenvolvimento com `--cds-forcar-local`, `DB_DIR` exclusivo sob `%TEMP%` e porta 3191. O backend entrou em `listening`, uma requisição HTTP à raiz respondeu 200 e os logs do Electron confirmaram o carregamento dos módulos da interface ERP. Não ocorreu falha nativa nesse smoke.

A base temporária estava vazia e sem sessão de usuário: os logs registraram HTTP 403 no dashboard/plataforma. Isso impediu iniciar um Pedido autenticado ou acessar a composição pela interface; não foi interpretado como falha do preço ou da composição. A inicialização também registrou avisos de colunas TEF já existentes (`duplicate column`), mas prosseguiu até abrir o servidor.

### Correção adicional verificada no fluxo de vínculo

A validação da venda persistida comparava o total líquido e as linhas, mas não comparava `vendas.desconto` com o desconto do snapshot. Também não provava que a soma bruta das linhas menos o desconto correspondia ao total do snapshot. `FaturamentoService` agora valida essas identidades antes de finalizar o Pedido. O teste integrado usa banco temporário, rejeita desconto divergente sem avançar o Pedido, recupera bruto/desconto/total, aceita a venda coerente e confirma que a repetição é idempotente.

Na interface, o PDV grava o `venda_id` no handoff antes de concluir pagamentos pendentes. O handoff não finaliza o Pedido enquanto o pagamento não fiscal estiver pendente; após a confirmação não fiscal, chama `finalizar-venda-pdv`. Se a venda já foi registrada, a recuperação impede criar outra e instrui retomar o pagamento da venda existente. O sucesso do endpoint é o que permite limpar o handoff ao concluir a tela. Esse comportamento foi inspecionado no código, mas não foi exercitado visualmente por falta de sessão autenticada.

O caminho de desconto manual existente exige autorização quando o pedido/venda corresponde à regra de desconto. A rota valida token de supervisor, perfil autorizado e identificador de uso único; a chamada de criação da venda rejeita falha com HTTP 403. Nenhuma dessas regras foi alterada. Os casos com operador sem permissão, supervisor autorizado e autorização cancelada/rejeitada continuam sem evidência runtime.

### Evidências e pendências por etapa

1. **Automatizados:** 97 testes de cotação, composição, limites de busca e UI passaram; a suíte integrada `sprint32-pedido-consumido-integracao.test.js` passou com 25 testes. Total executado nas duas seleções: 122 passaram, 0 falharam.
2. **Backend–PDV:** a recuperação do snapshot e o vínculo transacional foram exercitados em banco isolado. Isso não equivale a enviar os itens pela interface real do PDV.
3. **Autorização:** o caminho de autorização existente foi inspecionado, mas não foram testados operador e supervisor reais; a base temporária não continha essas sessões/credenciais.
4. **Pagamento e fiscal:** não houve pagamento, TEF, emissão NF-e/NFC-e ou conferência do documento fiscal.
5. **Estoque, ledger e estorno:** não houve venda PDV real nem conferência de baixa, ledger, cancelamento ou estorno. Os testes de vínculo não comprovam esses efeitos.
6. **Electron operacional:** somente o smoke de boot/carregamento foi observado. O fluxo Pedido → handoff → autorização → pagamento → fiscal → estoque não foi executado.

Para continuar com segurança, é necessário um build ERP/PDV contendo o código atual e um ambiente de homologação local com conta de operador e supervisor de teste, caixa, catálogo e configuração fiscal válidos. Até isso existir, a integração operacional permanece **não homologada**. Nenhum banco oficial foi aberto ou alterado, e nenhuma migração ou commit foi executado nesta etapa.

## Atualização — diagnóstico do retorno do PDV ao login, 25/10/2026

### Ambiente observado e limite de reprodução

- O processo ativo foi identificado como `electron .`, iniciado pelo Node a partir do workspace, com `package.json` versão `1.0.3` e `electron.js` como entrypoint. Não é uma execução de `app.asar`.
- A porta 3001 pertence a esse processo. O processo permaneceu ativo durante a inspeção; isso não informa se ele já reiniciou antes nem distingue uma navegação do renderer de uma reinicialização anterior.
- Não foram encontrados arquivos no diretório local `logs`. A inspeção não acionou telas, endpoints nem operações de venda no processo ativo.
- `electron.js` define `C:\ProgramData\MercantilFiscal\dados` como `DB_DIR` padrão quando a variável não está definida; esse caminho existe. Como não foi possível confirmar um `DB_DIR` descartável para o processo ativo, ele foi tratado como potencialmente operacional e não foi usado para reproduzir.

### Evidência de código — caminho possível para a tela de login

- `frontend/pdv/js/pdv.js` envia `POST /vendas` por `$.ajax`, que usa o handler global registrado em `frontend/shared/js/core.js`. Uma resposta HTTP 401 é classificada como sessão expirada e remove `token`/`user`, navegando para `/login`. Respostas 403 também acionam isso quando o corpo indica token/sessão ou tem mensagem exatamente `Acesso negado`.
- `backend/middleware/auth.js` responde 401 com `Acesso negado` e `code: SESSAO_INVALIDA` quando não há token; token inválido/expirado retorna 403 com mensagem explícita. Portanto, uma falha de autenticação no POST de criação da venda pode explicar a navegação ao login.
- A negativa de autorização de desconto em `VendaPagamentoService` retorna 403 com mensagem de autorização, que não corresponde aos critérios acima. Pelo código inspecionado, essa resposta isolada não deve limpar a sessão.
- A chamada `finalizar-venda-pdv` usa `fetch`, valida a resposta e lança erro tratado no callback de sucesso; nesse erro, o fluxo não chama `finalizarPosVenda`. O handoff com `venda_id` fica no `sessionStorage`, e a recuperação evita criar uma segunda venda. Não foi observado nesse caminho um comando de logout.
- Os pontos `app.relaunch()` encontrados no código Electron estão nos fluxos explícitos de alteração/retorno do modo de rede, não no callback de finalização de venda. A inspeção estática não demonstra se houve encerramento nativo ou reload no incidente relatado.

### Diagnóstico e próxima evidência necessária

O código mostra um caminho condicionado à resposta HTTP para retornar ao login, mas não há log correlacionado do incidente (status e corpo de `/api/vendas`, pagamento e `finalizar-venda-pdv`, console do renderer, PID antes/depois). Assim, **a causa raiz não está confirmada** e nenhuma correção de produção foi feita para evitar um ajuste especulativo.

Para reproduzir, usar um lançamento local com `DB_DIR` descartável confirmado, usuário de teste, caixa e configuração fiscal/sandbox. A evidência necessária é o horário e o ID de pedido/venda, status HTTP e código/mensagem de resposta de cada etapa, stack trace do backend/renderer e os PIDs antes/depois; remover tokens, credenciais e dados pessoais. A homologação de autorização, pagamento, fiscal, estoque e a identificação definitiva do reinício permanecem pendentes desse ambiente.

### Tentativa isolada após confirmação do ambiente

Com confirmação do usuário de que `C:\ProgramData\CDS Cremolicia\dados` é descartável, o Electron de desenvolvimento foi iniciado com esse `DB_DIR`, modo local forçado e porta 3000. O log registrou `HTTP LISTENING` na porta 3000 e a raiz respondeu HTTP 200. O acesso a `/pdv` redirecionou para `/login`, como esperado sem sessão. A interface carregada exibe versão `1.0.0`, enquanto o `package.json` do workspace declara `1.0.3`.

A base isolada contém um usuário ativo com perfil de superadministrador e hash de senha configurado; não foi possível autenticar com as credenciais disponíveis, e não foi registrado status/corpo HTTP de uma tentativa bem-sucedida. O usuário confirmou que não consegue entrar. O processo Electron terminou com código de saída 0, sem stack trace de falha no log; não há evidência para determinar se a janela foi encerrada pelo operador ou pelo aplicativo. Não houve venda, pagamento, baixa ou movimento de estoque nesta tentativa. O caminho `C:\ProgramData\MercantilFiscal\dados` informado separadamente não foi usado.

A causa do acesso negado e a causa do incidente original continuam **não comprovadas**. Embora tenha sido autorizada a criação de contas temporárias, ela não foi executada porque o banco indicado não tem os fixtures comerciais/operacionais necessários. Nenhum código de produção foi alterado nesta etapa.

Após a autorização para contas temporárias, foi consultado somente o banco descartável em modo SQLite read-only, sem ler nomes, hashes ou outros dados pessoais. Ele contém uma conta ativa, mas zero registros nas tabelas `produtos`, `pedidos`, `pedidos_itens`, `vendas`, `caixas`, `caixa_sessoes` e `usuario_permissoes`. Logo, mesmo obtendo uma sessão, esse banco não tem os fixtures comerciais/operacionais necessários para reproduzir a venda. Nenhuma conta foi criada e nenhuma venda ou movimento foi inserido. O caminho `C:\ProgramData\MercantilFiscal\dados` não foi acessado.

## Atualização — reprodução controlada e causa raiz confirmada (25/10/2026)

Esta atualização substitui a pendência de confirmação acima para o fluxo reproduzido na cópia descartável. O banco operacional não foi acessado. A reprodução usou o Pedido de teste 3 e a operação PDV 2, sem alterar registros históricos.

### Causa raiz

Antes da correção, o renderer enviou `POST /api/vendas` sem o cabeçalho `Authorization`; a inspeção do request no DevTools registrou apenas a ausência do cabeçalho, sem capturar nem exibir seu conteúdo. A resposta foi HTTP 401 e o renderer navegou para `/login`, limpando a sessão. O processo Electron permaneceu ativo com o mesmo PID, portanto a evidência aponta para logout/redirecionamento do renderer, não encerramento ou reinício nativo.

Em `frontend/pdv/js/pdv.js`, `enviarVenda` definia um `beforeSend` específico para anexar o contexto da empresa. No jQuery, esse callback local substitui o `beforeSend` configurado globalmente em `frontend/shared/js/core.js`; por isso o cabeçalho Bearer que o callback global acrescenta não era enviado nessa criação de venda. O middleware `backend/middleware/auth.js` responde 401 quando a requisição chega sem token, e o handler global do `core.js` trata esse 401 como sessão inválida e encaminha para o login. As chamadas de pré-cálculo e configuração imediatamente anteriores responderam 200.

Também foi observado um 401 de `/api/terminais/auto/offline` durante uma recarga; isoladamente, ele não encerrou a sessão e não impediu a execução corrigida. O 401 determinante foi o POST de criação da venda sem o cabeçalho.

O ajuste foi limitado ao `beforeSend` local da criação de venda: ele agora acrescenta o token disponível e continua anexando o cabeçalho da empresa. Não foram alterados autenticação backend, política de desconto, pagamento, faturamento, Motor Fiscal, estoque ou composição.

### Evidência depois da correção

Com o código recarregado no mesmo Electron, o request de criação continha o cabeçalho Bearer e `POST /api/vendas` respondeu 200. O endpoint oficial `POST /api/pedidos/3/finalizar-venda-pdv` também respondeu 200. O Pedido 3 ficou `FATURADO`, a operação 2 ficou `FINALIZADA` e ambas foram vinculadas à venda 22, na empresa 1. Valores persistidos: bruto da composição R$ 21,98, desconto global R$ 5,00 e total/pagamento em dinheiro R$ 16,98. O carrinho e o handoff foram limpos após a confirmação, enquanto o renderer permaneceu em `/pdv/` com sessão válida e o mesmo processo Electron ativo.

Para impedir qualquer emissão fiscal real, o modo foi desativado pela interface apenas na cópia de teste. O PDV exibiu um comprovante não fiscal; não foi observada chamada a endpoint fiscal nem a serviço externo. Isso não comprova emissão fiscal em homologação. Uma nova preparação oficial retornou `recuperacao: true`, `venda_concluida: true` e a venda 22; repetir a finalização oficial retornou `idempotente: true`. Os totais de vendas, pagamentos, consumo e finalizações permaneceram iguais após essas duas tentativas.

Apesar do modo completo e do comprovante não fiscal, a venda persistiu `valor_fiscal = 16,98` e `valor_nao_fiscal = 0`; isso não foi acompanhado de emissão fiscal. A inspeção posterior confirmou no código que `emitir_fiscal` controla a emissão de NFC-e, enquanto `venda_fiscal` orienta a prioridade de distribuição entre saldos fiscais e não fiscais. A distribuição ainda pode classificar o valor no saldo fiscal quando não há saldo não fiscal disponível. Portanto, esses campos descrevem o rateio fiscal/não fiscal da venda, não comprovam emissão de documento. A combinação observada é compatível com os saldos disponíveis, mas não substitui a homologação fiscal. `financial_ledger` permaneceu sem registros neste cenário.

O snapshot de consumo vinculado à venda registra os requisitos do Pedido original (insumo da ficha técnica 752 e produto simples 751), não os itens da composição fiscal. Após a finalização, os saldos empresariais consultados eram 199 para o produto 751 e 196 para o insumo 752; os itens da composição 747 e 748 permaneceram nos saldos previamente verificados de 250 e 2.000. Não foi capturada a linha de base dos produtos 751/752 antes da venda e não há movimento com referência 22 nas tabelas gerais `estoque_movimentos` ou `estoque_movimentacoes`; portanto, este resultado não é declarado como validação completa do ledger nem do delta físico. Não foram testados cancelamento/estorno, autorização negada por operador comum, falha de pagamento, rollback por exceção ou emissão fiscal.

### Testes e limites

- `node --check frontend/pdv/js/pdv.js`: aprovado.
- `node --test tests/pdv/pdv-processando-timeout-venda.test.js`: 7 testes aprovados, incluindo a regressão do cabeçalho de autenticação.
- `node --test tests/vendas/pedido-pdv-composicao.test.js`: 14 testes aprovados.
- `tests/vendas/fiscal-402-desconto-pagamento.test.js`: 30 testes aprovados com `DB_DIR` descartável.
- `tests/vendas/rc7101-valor-fiscal-liquido.test.js`: 15 testes aprovados com `DB_DIR` descartável.
- `tests/faturamento/sprint32-pedido-consumido-integracao.test.js`: 25 testes aprovados em banco temporário.
- `git diff --check`: aprovado; apenas avisos de normalização CRLF/LF em arquivos já modificados.

Uma execução combinada inicial foi interrompida por dois testes que exigiam `DB_DIR` e pelo teste de regressão que ainda não aceitava o comentário explicativo; a asserção foi ajustada e os testes fiscais foram repetidos com diretório descartável, sem liberar acesso ao banco oficial. A homologação fiscal, a falha de pagamento/autorização, o rollback e a comprovação de movimentos físicos antes/depois permanecem pendentes.

Após a coleta das evidências, o processo Electron de teste foi encerrado e as cópias temporárias do banco, perfil e diretórios de teste foram removidas. Nenhum commit foi criado.

## Atualização — homologação de estoque, fiscal e pagamento (25/10/2026)

### Autoridades encontradas no código

- A baixa do consumo físico do Pedido passa por `PedidoConsumoEstoqueService.registrarConsumo` → `debitarEstoqueItemVenda` → `estoqueSaldosPublico.debitarSaldo`. A autoridade do saldo persiste `produtos.saldo_fiscal`, `saldo_nao_fiscal` e `estoque_atual`, e espelha o contexto empresarial em `estoque_empresa`; para este fluxo, `empresa_id` é obrigatório.
- O ledger operacional do Pedido é `pedido_estoque_consumos` + `pedido_estoque_consumo_itens`, com vínculo/idempotência em `pedido_estoque_consumo_finalizacoes` e deltas comprovados em `pedido_estoque_consumo_ajustes`. O estorno do consumo é registrado em `pedido_estoque_estornos`, `pedido_estoque_estorno_itens`, `pedido_estoque_estorno_movimentos` e `pedido_estoque_estorno_solicitacoes`.
- `financial_ledger` não é a autoridade desta baixa. As tabelas genéricas `estoque_movimentos` e `estoque_movimentacoes` também não recebem automaticamente os débitos feitos por `estoqueSaldosPublico`; `CDS_LOG_SALDOS=1` oferece log estruturado em console, não um registro persistente. Portanto, a evidência apropriada combina os saldos de `produtos`/`estoque_empresa` com o ledger específico do Pedido, não exige uma linha em `financial_ledger`.
- O cancelamento de venda consulta o vínculo ao Pedido e, se houver consumo confirmado, executa `solicitarEstorno` na mesma transação local antes de marcar a venda como cancelada. Para vendas sem consumo de Pedido, preserva o caminho legado de devolução de itens e estorno da ficha técnica.

### Evidência operacional disponível e lacunas

A execução Electron anterior persistiu a venda 22 para o Pedido 3, operação 2, empresa 1, com pagamento em dinheiro quitado. O ledger de consumo registra dois itens físicos do insumo 752 (ficha técnica) e um do produto simples 751; a finalização relaciona consumo 3 à venda 22 e à empresa 1. Os saldos empresariais consultados depois eram 196 para o insumo 752 e 199 para o produto 751. Os itens da composição fiscal 747/748 não aparecem nesse snapshot de consumo físico.

Não foram registrados os saldos empresariais iniciais de 751/752 antes daquela finalização. Logo, os valores finais e o ledger comprovam os requisitos armazenados e o vínculo, mas **não comprovam o delta exato de estoque nem, isoladamente, que cada requisito foi debitado exatamente uma vez**. Também não houve referência à venda 22 nas tabelas genéricas de movimentos. A recuperação repetida não alterou a quantidade de vendas, pagamentos ou finalizações do banco temporário, e o endpoint oficial respondeu `idempotente: true`; isso demonstra idempotência do vínculo/consumo, não substitui a comparação de saldo pré/pós.

O ambiente Electron foi encerrado e as cópias temporárias usadas naquela execução foram removidas. Não foi criada outra base integrada com catálogo, ficha técnica, saldos empresariais iniciais identificáveis, caixa e autenticação de teste para repetir a operação, testar rollback por falha controlada na mesma venda e executar o cancelamento de ponta a ponta. Não foi acessado banco oficial nem criado movimento de teste no banco operacional.

### Testes nesta etapa

- `tests/pedidos/pedido-consumo-estoque.test.js`: **24 passaram; 0 falharam**, com `DB_DIR` descartável. Inclui ficha técnica, personalização, unidade fracionada, multiempresa, saldo insuficiente, idempotência, falhas injetadas/rollback e cancelamento do Pedido consumido. Esse cancelamento é do Pedido, não comprova o endpoint de cancelamento de uma venda vinculada.
- `tests/faturamento/sprint32-pedido-consumido-integracao.test.js`: **25 passaram; 0 falharam** no teste temporário anteriormente executado, incluindo rollback, retries, consumo único, vínculo e concorrência.
- `tests/faturamento/hotfix-310-modo-operacional.test.js` e `tests/vendas/rc7101-valor-fiscal-liquido.test.js`: **19 passaram; 0 falharam**, com `DB_DIR` descartável. O contrato separa emissão NFC-e, rateio fiscal/não fiscal, desconto líquido e pagamento.
- `tests/faturamento/rc514-token-uso-unico.test.js` e `tests/faturamento/rc515-token-escopo.test.js`: execução não aprovada. Ambos falharam ao atingir `EstoqueEmpresaService` porque o banco descartável de teste não tinha a tabela `empresas` (`SQLITE_ERROR: no such table: empresas`). Não indica falha comprovada na autorização em produção; também não fornece aprovação para o fluxo de desconto.

### Estado de aceite

O pagamento à vista de R$ 16,98, o vínculo Pedido–Venda e a recuperação idempotente foram demonstrados uma vez no Electron descartável. Naquela execução, faltou capturar os saldos iniciais e não foram executados cancelamento/estorno, autorização negada, falha de pagamento ou emissão fiscal. A análise do rateio `valor_fiscal`/`valor_nao_fiscal` esclareceu que esses campos não são equivalentes à emissão. A atualização da Sprint Final abaixo fecha parte dessas lacunas em testes automatizados com base descartável; não substitui homologação real do PDV, pagamento externo ou NFC-e.

**Conclusão:** a homologação final de estoque, fiscal e pagamento permanece **pendente**. Nenhum defeito de produção novo foi comprovado nesta etapa; nenhum código de produção foi alterado e nenhum commit foi criado.

## Sprint Final — fechamento das evidências automatizadas (25/10/2026)

### Fixtures de autorização corrigidos

Os fixtures de RC514 e RC515 agora chamam os schemas oficiais `garantirSchemaEmpresasAsync` e `garantirSchemaEstoqueEmpresaAsync`, cadastram a empresa via `EmpresaService.criarEmpresa` e criam os saldos por produto/empresa via `EstoqueEmpresaService.criarRegistro`. Pedidos recebem o ID retornado pelo serviço, sem presumir que exista uma empresa padrão. A base de contexto do `backend/database.js` foi fornecida por `DB_DIR` temporário; os dados do motor foram executados em arquivos SQLite descartáveis e removidos ao fim dos testes. O guard do banco oficial nunca foi desativado.

Resultados:

- `node tests/faturamento/rc514-token-uso-unico.test.js`: **6/6 passaram**. Inclui primeiro uso, reuso com `TOKEN_JA_UTILIZADO`, token sem `jti`, supervisor autorizado pelo Motor Comercial e propagação do reuso. Novo cenário com `role=user`/`perfil=CAIXA` foi recusado com `AUTORIZACAO_REJEITADA`; para Pedido 501/empresa 1/produto 1, saldos iniciais 5 fiscal + 100 não fiscal e reserva 0 permaneceram inalterados.
- `node tests/faturamento/rc515-token-escopo.test.js`: **5/5 passaram**. Token autorizado no Pedido correto; Pedido, produto e quantidade divergentes foram rejeitados com `TOKEN_FORA_DO_ESCOPO`.
- A execução inicial sem `DB_DIR` foi barrada pelo `sqliteOfficialGuard` antes dos testes. Repetida com diretórios temporários. O aviso `JWT_SECRET não definido` indica a chave de desenvolvimento do harness; não foi usada credencial de produção.

### Saldo, venda, ledger e estorno automatizados

O cenário integrado de teste cria empresa, produto, saldo empresarial e Pedido em banco descartável, registra os saldos antes, fatura o Pedido, captura `vendas.pedido_id` e `empresa_id`, confere `pedido_estoque_consumo_itens` e `pedido_estoque_consumo_finalizacoes`, e exercita o helper de estoque chamado pelo cancelamento da venda (`devolverEstoqueEEstornarFichaDaVenda`) dentro de transação. A saída reproduzível desta execução foi:

- IDs de teste: empresa **1**, Pedido **4**, venda **4**, produto **4**.
- Antes da venda: `produtos` e `estoque_empresa`, empresa 1 — fiscal **10**, não fiscal **0**, total **10**; reservado fiscal **2** após reserva do Pedido.
- Após venda: fiscal **8**, não fiscal **0**, total **8**; reservado fiscal **0**. Delta físico fiscal **−2** nos saldos global e empresarial.
- Snapshot `pedido_estoque_consumo_itens`: produto **4**, quantidade **2**, empresa **1**. `pedido_estoque_consumo_finalizacoes`: Pedido **4**, consumo **4**, venda **4**, empresa **1**.
- Após estorno: fiscal **10**, não fiscal **0**, total **10**, reservado **0**. `pedido_estoque_estornos` registrou um estorno; `pedido_estoque_estorno_movimentos` registrou um movimento de **2**, tipo `FISCAL`, produto 4, empresa 1.
- Repetir o helper de estorno preservou os mesmos saldos e manteve exatamente um estorno e um movimento. A reserva não foi restaurada: permaneceu liberada em zero, como esperado após a venda e reversão física.

`tests/faturamento/sprint32-pedido-consumido-integracao.test.js` passou **26/26**, incluindo os testes existentes de consumo, retry/idempotência, divergência, rollback injetado e recuperação, mais o novo cenário acima. Esse cenário chama o helper de estoque dentro de transação; **não** executa o endpoint `cancelarVendaPost`, não marca a venda como cancelada, não testa cancelamento de pagamentos e não comprova a resposta HTTP completa. A extensão, portanto, valida o estorno do ledger físico, mas a homologação ponta a ponta de cancelamento continua pendente.

Outras suítes isoladas executadas:

- `node --test tests/pedidos/pedido-consumo-estoque.test.js`: **24/24**.
- `node --test tests/faturamento/hotfix-310-modo-operacional.test.js tests/vendas/rc7101-valor-fiscal-liquido.test.js`: **19/19**.
- `node --test tests/vendas/fiscal-402-desconto-pagamento.test.js`: **30/30**. Cobre aplicação do desconto e rejeição de pagamento abaixo do líquido; não simula recusa/cancelamento real de adquirente/TEF.
- `node --test tests/pdv/pdv-processando-timeout-venda.test.js`: **7/7**.
- `node --test tests/vendas/pedido-pdv-composicao.test.js`: **14/14**.
- `node --check` nos três testes alterados e `git diff --check`: aprovados. Avisos de finais CRLF/LF em arquivos já modificados não são erros de whitespace.

### Pendências de homologação externa

Não foi executado pagamento real ou simulado por gateway/adquirente, fluxo de cancelamento financeiro nem o endpoint completo de cancelamento da venda. Também não foi chamada a SEFAZ: não há nesta execução evidência de certificado/credencial/endpoint de homologação autorizado, resposta oficial, chave/protocolo ou XML autorizado. São dependências explícitas para concluir a homologação fiscal, não resultados inferidos dos testes de distribuição fiscal ou de comprovante não fiscal.

**Conclusão atual:** os testes automatizados de autorização, saldo inicial/final, consumo único, rollback e estorno pelo helper passaram em ambiente isolado; a homologação completa permanece **PENDENTE** até comprovação do cancelamento HTTP/financeiro, respostas reais de pagamento e emissão/autorização de NFC-e em ambiente fiscal de homologação. Nenhum banco oficial foi acessado e nenhum movimento de teste persistiu fora dos diretórios descartáveis removidos.

## Sprint P0 — Imutabilidade de pedidos encerrados (25/10/2026)

A edição agora é bloqueada quando o pedido está `FATURADO` ou `CANCELADO`, possui venda vinculada em `pedidos.venda_id`, `vendas.pedido_id` ou `pedido_faturamento_operacoes`, ou tem finalização confirmada em `pedido_estoque_consumo_finalizacoes`/operação PDV `FINALIZADA`. Uma operação `INICIADA` sem venda continua editável conforme o fluxo existente.

O backend expõe o estado de bloqueio na consulta/listagem e valida novamente durante a transação de atualização. O repositório também protege chamadas diretas de substituição e exclusão. A interface apresenta aviso, mantém itens e totais consultáveis, desabilita os campos e oculta as ações de edição; impressão continua disponível. Pedidos em andamento sem venda/finalização preservam o fluxo atual.

Validação desta sprint, toda com `DB_DIR` temporário e sem acessar o banco oficial:

- `tests/pedidos/pedido-encerrado-imutabilidade.test.js`: **5/5**; cobre Pedido aberto, faturado com/sem venda, vínculos por venda, finalização de consumo/PDV, operação ainda iniciada, gravação direta no repositório e consulta.
- Suítes focadas de consumo, preço/personalização, interface Pedido–PDV e integração de faturamento: **70/70**.
- `tests/pedidos/pedido-operacional-sprint-b1.test.js`: **2/3**. O caso restante continua falhando porque seu fixture pede validação de total, mas não cadastra o produto 1 e recebe `Produto 1 não encontrado`; não alterei o teste nem a regra de criação, fora do escopo desta sprint.
- `node --check` dos arquivos de produção/teste alterados e `git diff --check`: aprovados.

Não houve execução no Electron por restrição explícita desta sprint. O Pedido 4 e a venda 24 permaneceram sem alteração; a reconciliação operacional continua pendente. A verificação automatizada confirma o bloqueio na interface/API/serviços, mas não substitui nova homologação visual.

## Ajuste de impressão térmica resumida de Pedidos

A ação de impressão da tela ERP → Pedidos passou a solicitar o formato térmico. O gerador A4 existente foi mantido, e as chamadas de `imprimirPedidoPorId` sem formato explícito continuam em A4 para preservar os consumidores do Faturamento.

O cupom térmico percorre `pedido.itens` na ordem recebida, sem agrupar ou recalcular linhas. Cada linha imprime somente quantidade, `produto_nome` (nome comercial resolvido pelo backend) e subtotal final. Não imprime código, nome fiscal, ingredientes, adicionais, ficha técnica, preço-base nem preço unitário. O cabeçalho mantém número, data e cliente; o resumo usa a soma dos subtotais e os valores existentes de desconto, frete e total.

No Electron, a impressão usa a configuração já existente `GET /configuracoes/impressora_cupom` e `window.electronAPI.abrirComprovante`. O layout marca `danfe-80`, correspondente ao padrão de 80 mm do manipulador em `electron-common.js`. A configuração atual da impressora retorna o dispositivo (`caminho`), mas não possui uma opção explícita de largura; instalações de 58 mm não foram homologadas nesta alteração. No navegador, permanece disponível a visualização com ação de impressão.

Validação automatizada com fixture dos dois “Pastel do Cheff” e “Cajuína São Geraldo 1L”, incluindo subtotais de R$ 21,99, R$ 24,99 e R$ 9,00:

- `tests/pedidos/pedido-impressao-termica.test.js`, `tests/pedidos/tela-pedidos-operacional-adaptada.test.js` e `tests/pedidos/preco-pedido-nome-comercial.test.js`: **19/19**.
- Confirmados três itens separados, nomes comerciais, ausência de dados de personalização, total R$ 55,98, encaminhamento ao dispositivo configurado e preservação do caminho A4 usado pelo Faturamento.
- `node --check` nos dois arquivos JavaScript alterados e `git diff --check`: aprovados.

Não foi aberta a aplicação Electron nem impressora física; portanto, o resultado comprova o HTML e o encaminhamento automatizado, não uma homologação visual ou impressão de hardware. Os testes foram executados com `DB_DIR` temporário removido ao final; nenhum banco oficial foi acessado.
