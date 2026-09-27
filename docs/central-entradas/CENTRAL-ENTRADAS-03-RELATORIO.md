# SPRINT CENTRAL-ENTRADAS-03 — Fechamento operacional da Central + Período padrão

Data: 27/09/2026

## STATUS

**CONCLUÍDO COM RESSALVAS — XML DAS FILIAIS NÃO COMPROVADO EM PRODUÇÃO.**

| Frente | Situação |
|---|---|
| Fluxo XML Matriz/F2/F3 (código) | AUTOMATIZADO — 17/17 cenários passam com a cadeia real Manifestação → `consultarNotaPorChave` → persistência |
| Fluxo XML Matriz/F2/F3 (SEFAZ real) | **BLOQUEADO** — ver "Bloqueios externos" |
| Auditoria dos documentos reais (Matriz PROC_NFE, F2 RESUMO/XML_INDISPONIVEL, F3 NF 541588) | **BLOQUEADO** — o banco disponível nesta máquina não é o banco multiempresa |
| Período padrão por empresa | AUTOMATIZADO — 12/12 cenários; teste manual na tela pendente |
| Regressão da Central | 49/78 suítes passam; as 29 que falham falham igual sem as alterações da sprint (pré-existentes) |

A Central **não** está sendo declarada concluída: nenhum XML de filial foi obtido na SEFAZ durante esta sprint.

---

## 1. Antes / depois

| Tema | Antes | Depois |
|---|---|---|
| Rejeição SEFAZ no consChNFe (632, 640, 593…) | `consultarNotaPorChave` lançava `Error` só com a mensagem; o cStat se perdia. O evento gravava `CONS_CHNFE_ERRO` e o motor gravava `ultimoRetorno: 'ERRO'` | O erro carrega `cStat`, `xMotivo` e `rejeicaoSefaz: true`. O evento `CONSULTA_DFE_POS_MANIFESTACAO` grava `resultado = cStat` e `detalhe.{cStat,xMotivo,rejeicaoSefaz}`; o motor grava `ultimoRetorno = cStat` e o evento de falha traz os mesmos campos |
| Regra de XML_INDISPONIVEL | Só após consChNFe cStat 137 | **Inalterada** (nenhuma rejeição passou a encerrar documento) |
| Lock do motor de recuperação | `_cicloEmExecucao` era marcado **depois** do `await obterConfig()`; dois ciclos simultâneos (scheduler + botão, por exemplo) passavam pela verificação e consultavam a mesma chave duas vezes | O lock é marcado antes do primeiro `await` e liberado se o motor estiver desativado ou se a leitura da config falhar. Comprovado por teste que falhava antes da correção |
| Período inicial da tela | Filtros de data vazios (todo o histórico) para todas as empresas | Configuração por empresa: `MES_VIGENTE` (padrão de novo cliente) ou `TODO_PERIODO` |

## 2. Auditoria Matriz / Filial 2 / Filial 3

### 2.1 Banco real — BLOQUEADO

O caminho oficial `C:\ProgramData\MercantilFiscal\dados\mercadao.db` (sem `DB_DIR` definido) contém nesta máquina **um banco diferente e mais antigo** que o auditado em 16/09 (CENTRAL-XML-MULTICNPJ-02):

- 66 documentos, criados entre 27/07/2026 e 25/08/2026;
- até o início da sprint **não havia** coluna `empresa_id` em `central_entradas_documentos` nem tabela `empresas`;
- os eventos mais recentes (27/09/2026 11:46 UTC) são 28 `RECUPERACAO_XML_TIMEOUT` do motor.

Por isso **não foi possível** registrar, para os documentos reais, empresa_id, CNPJ, chave, NF, série, NSU, status, tipo_documento, último evento, cStat, xMotivo, tentativa, data/hora e XML. Os dados conhecidos desses documentos continuam sendo os do relatório MULTICNPJ-02 (doc 18, NF 541588, empresa 3, CNPJ …0002-04, RES_NFE, 596 "Evento apresentado apos o prazo permitido para o evento: [10 dias]", sem consChNFe naquela versão; F2 NF 252818 doc 19 no mesmo padrão; Matriz PROC_NFE docs 42/43/44).

**Ocorrência a registrar:** a primeira execução da nova suíte XML carregou `backend/database.js` contra esse caminho oficial, e as **migrações aditivas** do próprio sistema rodaram no banco: tabelas `empresas`, `usuario_empresas`, `estoque_empresa`, `contas_pagar`, `instituicao_financeira`, `ficha_tecnica`, `atendimentos`, `venda_ficha_consumo` e a coluna `empresa_id` em `central_entradas_documentos`. Conferi que nenhum dado da Central mudou (66 documentos, 2341 eventos, `updated_at` da configuração igual ao anterior). Nenhuma linha foi inserida ou alterada manualmente. As suítes novas agora substituem `database.js` por SQLite em memória e nunca abrem o banco oficial.

### 2.2 Auditoria de código (contexto multiempresa)

| Etapa | Empresa usada | Fallback global no MULTIEMPRESA |
|---|---|---|
| DistDFe (sync) | empresa ativa da requisição (`resolverEmpresaParaCentral`) | não |
| Manifestação 210210 | `resolverContextoDocumentoCentral` a partir de `documento.empresaId` (CNPJ + PFX `certificado-empresa-<id>.pfx`) | não (`permitirFallbackGlobal` só em EMPRESA_SIMPLES) |
| consChNFe pós-596 | mesmo contexto do documento | não |
| Motor de recuperação | contexto de cada documento da fila (fila lista todas as empresas; cada consulta usa a empresa do documento) | não |
| Persistência | busca por `chave + empresa_id`; procNFe atualiza o mesmo registro | não |

Os testes da suíte XML confirmam: a chamada SOAP de cada empresa sai com o CNPJ e o PFX dela, e um procNFe recebido pela Filial 2 nunca atualiza um documento da Filial 3 ou da Matriz.

## 3. Critérios de XML_INDISPONIVEL

- **Quem cria:** somente `CentralManifestacaoDfeService._encerrarXmlIndisponivel`, chamado por `_resolverAposEvento596`.
- **Quando:** ciência 210210 retornou 596 (na hora ou já registrado em evento anterior) **e** o consChNFe feito em seguida retornou **cStat 137** (nenhum documento localizado).
- **Não cria XML_INDISPONIVEL:** 596 sozinho; 656 (consumo indevido; aciona cooldown); erro de transporte/timeout; rejeições 632/640/593 etc. (o documento continua aguardando e agora guarda o cStat real). O motor de recuperação nunca coloca XML_INDISPONIVEL.
- **Terminal?** Só para o ciclo de ciência: não se remanifesta. Continua **recuperável**: entra na fila do motor (RC3.7.5), que reconsulta por consChNFe até 48 tentativas ou 30 dias; se sair por timeout, volta no ciclo seguinte com nova contagem.
- **Reprocessável:** quando o consChNFe devolve procNFe (vira PROC_NFE no mesmo registro) ou pela reabertura em lote (RC3.4.8), que o devolve para RESUMO_RECEBIDO.
- **Recomendação sem mudança de regra:** 632/653/654 podem indicar indisponibilidade real; só alterar a regra com evidência de produção, que agora passa a ser registrada (cStat e xMotivo) nos eventos.

## 4. cStats tratados (comprovação automatizada)

| cStat | Onde | Resultado |
|---|---|---|
| 135 | ciência Matriz | aguarda janela/NSU; não chama consChNFe nem o fluxo 596 |
| 596 | ciência | chama consChNFe da mesma empresa |
| 138 | consChNFe | procNFe persistido como PROC_NFE no mesmo documento |
| 137 | consChNFe pós-596 | XML_INDISPONIVEL com cStat/xMotivo registrados; no motor o documento continua monitorado |
| 656 | consChNFe (manifestação) | não encerra; próxima janela |
| 656 | motor | aciona o Gate existente e interrompe o lote (sem retry paralelo) |
| 632 / 640 | consChNFe / motor | cStat/xMotivo preservados no evento e no estado; sem XML_INDISPONIVEL |
| erro HTTP/transporte | consChNFe | não vira XML_INDISPONIVEL |

xMotivos reais de SEFAZ desta sprint: **nenhum** (não houve chamada real).

## 5. Correções realizadas

1. `backend/services/fiscal/distribuicaoDFe.js`: a rejeição do consChNFe preserva `cStat`, `xMotivo`, `rejeicaoSefaz` no erro lançado (mensagem inalterada).
2. `CentralManifestacaoDfeService._consultarXmlCompletoPorChave`: o evento e o retorno registram o cStat real da rejeição.
3. `MotorRecuperacaoXmlService`: registra o cStat real no estado do documento e no evento; **lock do ciclo corrigido** (corrida entre chamadas simultâneas).

O cStat lançado **não** é repassado ao Gate: ele é global, e um 593 de uma filial suspenderia todas as empresas. Isso fica registrado como limitação.

## 6. Período padrão

- **Persistência:** tabela existente `central_entradas_config` via `CentralConfiguracaoRepository`; chave por empresa `periodo_padrao_empresa_<id>`. Nenhuma tabela nova.
- **Opções:** somente `MES_VIGENTE` ("Mês vigente", do dia 01 do mês até hoje, em data local) e `TODO_PERIODO` ("Todo o período", sem limites). Qualquer outro valor → HTTP 400 `PERIODO_PADRAO_INVALIDO`.
- **Novo cliente:** sem registro → `MES_VIGENTE` (`origem: PADRAO_NOVO_CLIENTE`). O GET não grava nada.
- **Isolamento:** cada empresa tem a sua chave; uma filial nunca herda a configuração da Matriz.
- **API:** `GET/PUT /api/central-entradas/configuracao/periodo-padrao` (empresa resolvida por `resolverEmpresaParaCentral`, header `X-Empresa-Id`).
- **Tela:** Configurações da Central → aba **Período padrão** (dois radios, empresa atual, configuração atual, botão Salvar). Ao abrir a Central e ao trocar para uma empresa específica, os filtros `data_emissao_inicio/fim` recebem o intervalo da empresa. Na vista "Todas", as datas não mudam.
- **O que não muda:** a configuração define apenas o valor inicial dos filtros. Documentos, NSU e histórico não são apagados nem ocultados; o operador pode alterar as datas manualmente; os filtros rápidos (hoje, ontem, 7 dias, 30 dias, este mês) continuam iguais.

## 7. Testes

### AUTOMATIZADO

- `tests/central-entradas/central-entradas-03-xml.test.js` — **17/17**: cadeia completa nas 3 empresas, 137 (manifestação e motor), 656 (manifestação e motor/Gate), transporte, 632, 640, retry de XML_INDISPONIVEL, XML já persistido, isolamento na persistência, isolamento no motor, documento antigo com 596 registrado (sem remanifestar nem duplicar), **lock contra ciclos simultâneos**, Matriz 135.
- `tests/central-entradas/central-entradas-03-periodo.test.js` — **12/12**: só duas opções, novo cliente, dia 01, data final = hoje, TODO_PERIODO, persistência, isolamento entre empresas, alteração/validação, filtro manual, histórico/NSU preservados, filtros rápidos, tela/rotas.
- Script: `npm run test:central-entradas-03`.

### Regressão (78 suítes de `tests/central-entradas`, banco temporário)

- **49 passam**, incluindo MULTICNPJ-01, MULTICNPJ-02, RC3.3.6, RC7.4.7, identidade documento/empresa (05-70), isolamentos 05-68/71/72/74/75, máquina de estados, RC3.7.1, RC3.7.5, NSU RC3.7.5.1/RC3.7.5.2, 05-76/77/78/79.
- **29 falham — PRÉ-EXISTENTES, NÃO RELACIONADAS.** Método: cópia do projeto com somente as alterações desta sprint revertidas, mesmas suítes e mesmo tipo de banco. As 29 falham igual, com a mesma quantidade de falhas dentro de cada suíte: auditoria-leitores-globais-05-73, sprint2, sprint4, sprint5, sprint7, sprint9, sprint10, rc1, rc3, rc31, rc33, rc333, rc343, rc346, rc348, rc349a, rc3753, rc376, rc4, rc40, rc6.2, rc6.4, rc6.5, rc74, rc741, rc742, rc743, rc75, rc833.
- A suíte geral do sistema (fora da Central) **não** foi executada.

### Defeito pré-existente encontrado (não corrigido)

Num banco **vazio**, `backend/database.js` derruba o processo com `SQLITE_ERROR: no such table: configuracoes`: há consultas/`db.run` sem callback sobre `configuracoes` que rodam antes do `CREATE TABLE` (linha ~2522, "criar por último"). Isso afeta a instalação limpa e as suítes antigas sem `DB_DIR`. Não foi corrigido porque está fora do escopo da sprint; recomendo tratar isso em sprint própria.

Observação: várias suítes antigas (e o `npm run test:central-entradas`) não definem `DB_DIR` e, sem ele, abrem o banco oficial ao carregar `database.js`.

### REAL-SEFAZ

**Não executado.** Não houve sync Matriz/F2/F3, ciência, consChNFe nem obtenção de procNFe contra a SEFAZ nesta sprint.

### BLOQUEADO

- Banco multiempresa de produção indisponível nesta máquina (seção 2.1).
- Teste funcional após reinício (sync das 3 empresas e acompanhamento RESUMO → manifestação → consChNFe → PROC_NFE) depende desse banco, dos certificados das 3 empresas e de acesso à SEFAZ.

## 8. Arquivos alterados

- `backend/services/fiscal/distribuicaoDFe.js`
- `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js`
- `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js`
- `backend/motores/central-entradas/services/CentralPeriodoPadraoService.js` (novo)
- `backend/rotas/central-entradas.js`
- `frontend/erp/js/central-entradas.js`
- `tests/central-entradas/central-entradas-03-xml.test.js` (novo)
- `tests/central-entradas/central-entradas-03-periodo.test.js` (novo)
- `package.json` (script `test:central-entradas-03`)

Não foram alterados: Motor Fiscal, MIIP, MUC, estoque, financeiro, PDV, Produção, TEF, Open Finance, Alô Chefia, equipamentos, regra de composição.

## 9. Limitações

- O Gate operacional (cooldown 656 / CONFIG_ERROR 593) é **global**: um 656 de uma empresa pausa a recuperação de todas.
- O motor reconsulta XML_INDISPONIVEL e RESUMO_RECEBIDO de todas as empresas num único lote de 5 por ciclo; não há cota por empresa.
- O período padrão só é aplicado na abertura da tela e na troca de empresa; salvar a configuração não mexe nos filtros já aplicados na sessão.

## 10. Próximos passos (validação em produção)

1. Na máquina com o banco multiempresa: reiniciar o sistema e sincronizar Matriz, F2 e F3.
2. Acompanhar doc 18 (F3, NF 541588) e doc 19 (F2, NF 252818): conferir o evento `CONSULTA_DFE_POS_MANIFESTACAO` (cStat/xMotivo agora gravados) e se o motor promove para PROC_NFE.
3. Registrar os cStats reais do consChNFe das filiais; só então decidir sobre 632/653/654.
4. Na tela: abrir Configurações → Período padrão em cada empresa, salvar e conferir os filtros ao trocar de empresa.
5. Corrigir em sprint própria a inicialização de banco vazio em `database.js`.
