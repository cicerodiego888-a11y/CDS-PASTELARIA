# CENTRAL-XML-MULTICNPJ-02 — Relatório

## STATUS

**CONCLUÍDO COM RESSALVAS**

Causa raiz do `XML_INDISPONIVEL` nas Filiais 2 e 3 identificada com evidência de banco. O classificador misturava **rejeição de ciência (cStat 596)** com **ausência de procNFe**. Correção aplicada no código.

Não houve teste funcional ponta a ponta contra a SEFAZ neste sprint (produção). Os documentos reais **não foram alterados**. Não se afirma que a SEFAZ “não tem o XML” da NF 541588 — **não existe retorno de `consChNFe` persistido para essa nota**.

## Causa raiz

Após CENTRAL-XML-MULTICNPJ-01, ciência e contexto passaram a usar o `empresa_id` do documento. A Filial 3 evoluiu de `RESUMO_RECEBIDO` para `XML_INDISPONIVEL` porque:

1. Ciência **210210** foi enviada com `empresaId = 3`.
2. A SEFAZ respondeu **HTTP 200** no `NFeRecepcaoEvento4` com **cStat 596** e xMotivo de **prazo de 10 dias**.
3. O classificador RC7.4.7 mapeava **596 → `XML_INDISPONIVEL` imediatamente**, **sem** `consChNFe`.
4. Não há evento `CONSULTA_DFE_POS_MANIFESTACAO` nem `docZip`/`procNFe` no documento.

**596 prova atraso do evento 210210, não prova que o Ambiente Nacional não tenha o XML.**

Emissão 20/08/2026; ciência 17/09/2026 — o prazo de 10 dias da NT é coerente com o 596. Isso **não** substitui a consulta por chave.

Classificação da matriz (documento 18, estado persistido **antes** da correção):

| Código | Aplica? | Evidência |
|--------|---------|-----------|
| A XML realmente indisponível na SEFAZ | **Não comprovado** | Sem `consChNFe` |
| B ciência ainda não realizada | Não | `CIENCIA_ENVIADA` |
| C ciência rejeitada | **Sim** | cStat 596 |
| D ciência aceita, XML ainda não disponível | Não | ciência não aceita |
| E consChNFe com contexto errado | **Não ocorreu** | consulta não foi chamada |
| F consChNFe ok, retorno não processado | Não | sem chamada |
| G docZip com parser falho | Não | sem docZip |
| H XML recebido, persistência falhou | Não | xml_len 517 = resNFe |
| I XML persistido, status errado | Não | tipo `RES_NFE` |
| J erro temporário como definitivo | **Parcial** | 596 tratado como ausência definitiva de XML |

## Evidência real — NF 541588 (Filial 3)

Consulta somente leitura em `mercadao.db`. Documento **não** alterado.

| Campo | Valor |
|-------|--------|
| id | 18 |
| empresa_id | 3 |
| CNPJ cadastro | 38.***.***/0002-04 |
| NF / série | 541588 / 1 |
| Fornecedor | ATACADAO S.A. |
| Emissão | 2026-08-20 |
| Valor | 210,77 |
| status | `XML_INDISPONIVEL` (desde 2026-09-17 01:33:30) |
| tipo_documento | `RES_NFE` |
| NSU | 000000000000004 |
| xml_len | 517 (resumo, não procNFe) |
| chave | mascarada `232608…0150` |

Eventos:

| Quando | Tipo | Resultado |
|--------|------|-----------|
| 2026-08-30 | DOCUMENTO_RECEBIDO | RESUMO_RECEBIDO |
| 2026-08-30 | RECUPERACAO_XML_ENTROU_FILA | — |
| 2026-09-17 01:33:29 | CIENCIA_ENVIADA | ENVIADA (`empresaId`: 3) |
| 2026-09-17 01:33:30 | MANIFESTACAO_REJEITADA | **596** |

**Não há** `CONSULTA_DFE_POS_MANIFESTACAO`, `RECUPERACAO_XML_CONSULTA`, `MANIFESTACAO_ACEITA`.

## Retorno SEFAZ persistido (ciência 210210)

Do `detalhe_json` do evento 1559 — **não inventado**:

| Campo | Valor |
|-------|--------|
| HTTP | 200 |
| endpoint | `https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx` |
| cStat | **596** |
| xMotivo | Rejeicao: Evento apresentado apos o prazo permitido para o evento: **[10 dias]** |
| runtime | PLATFORM |
| tpAmb | **não persistido** neste evento |
| protocolo / nProt | **não persistido** neste evento |
| CNPJ no detalhe | não; `empresaId` 3 no evento de ciência |
| NSU | do documento: 000000000000004 |
| docZip | **ausente** |
| procNFe | **ausente** |

O SOAP bruto do retorno **não** fica gravado; o parser persiste cStat/xMotivo/HTTP/endpoint. Resposta de **`consChNFe` não existe** — foi descartada por **não ter sido chamada**, não por drop após o parser.

## Ciência 210210

Houve cadeia:

`CIENCIA_ENVIADA` → `MANIFESTACAO_REJEITADA` (596), **sem** aceite 135/573.

- empresa_id no evento: **3**
- CNPJ esperado: Filial 3 (…0002-04), alinhado ao contexto MULTICNPJ-01
- PFX: certificado da empresa 3 (não reaberto neste sprint; isolamento já comprovado na 01)
- chave: NF 541588
- cStat / xMotivo: 596 / prazo 10 dias
- protocolo: não persistido no JSON do evento

## consChNFe (antes da correção)

**Não executado** para a 541588. Sem fallback DistDFe pós-596 (RC7.4.7 pulava DistDFe). Não há evidência de consulta com CNPJ da Matriz neste documento **neste** ciclo de 17/09; o problema aqui é o **atalho 596 → XML_INDISPONIVEL**.

Regra de contexto (pós-01, mantida):

| Empresa | CNPJ | PFX |
|---------|------|-----|
| Matriz (1) | …0001-15 | certificado-empresa-1.pfx |
| Filial 2 (2) | …0003-87 | certificado-empresa-2.pfx |
| Filial 3 (3) | …0002-04 | certificado-empresa-3.pfx |

Sem fallback para Matriz quando `empresaId` está no documento.

## docZip / persistência

No documento 18: XML é resumo (`RES_NFE`, 517 bytes). Sem gzip/docZip. Persistência do resumo está coerente. **Não** é o caso “docZip recebido e status errado”.

## Filial 2 (comparação)

Caso selecionado: NF **252818**, id **19**, empresa_id **2**, SENDAS, `XML_INDISPONIVEL`, `RES_NFE`, xml_len 533.

Mesmo padrão da 541588:

- `CIENCIA_ENVIADA` com `empresaId`: **2**
- `MANIFESTACAO_REJEITADA` cStat **596**, HTTP **200**, mesmo endpoint RecepcaoEvento4, mesmo xMotivo de prazo 10 dias
- **sem** consChNFe persistido
- NF 183346 (tela) está no mesmo grupo (id 12)

Outras da Filial 2 no recorte: 251616, 183347, 183346, 250906, 183062, 10339, 182793 — todas `XML_INDISPONIVEL` / `RES_NFE`.

## Matriz

PROC_NFE recente (xml completo): id 44 NF 431 (10377 bytes), 43 NF 1104, 42 NF 23060 — status `EM_REVISAO`. DistDFe da Matriz **não** foi alterado neste sprint.

Filial 3 ainda tem documentos em `RESUMO_RECEBIDO` (ex. 4422, 184468) — ciência/596 ainda não aplicada neles.

## cStat tratados no fluxo atual

**Evento 210210 (manifestação):**

| cStat | Significado no código | Efeito |
|-------|----------------------|--------|
| 135 | Aceite | segue aguardando XML (NT: PROC não é imediato) |
| 573 | Duplicidade aceita | igual 135 |
| 596 | Evento fora do prazo | **agora:** `consChNFe` no CNPJ do documento; `XML_INDISPONIVEL` **somente** se `consChNFe` retornar **137** |
| demais | Rejeição | cooldown 1 h; **não** vira `XML_INDISPONIVEL` |

**DistDFe / consChNFe (`retornoDistSucesso`):**

| cStat | Significado | Efeito |
|-------|-------------|--------|
| 137 | Nenhum documento localizado | sem docZip; após 596, **este** é o critério de `XML_INDISPONIVEL` |
| 138 | Documento(s) no lote | parser/persistência; se virar PROC_NFE, status sobe |
| 656 | Consumo indevido | cooldown; **não** encerra como XML indisponível |
| outros | erro/rejeição SOAP | `consultarNotaPorChave` lança; **não** encerra como 596 |

Códigos novos **não** foram inventados.

## Regra `XML_INDISPONIVEL`

- Criado por `_encerrarXmlIndisponivel` (RC7.4.7), disparado a partir de `_resolverAposEvento596`.
- Terminal na máquina de ciência (`processarDocumento` ignora se já está nesse status — sem remanifestar).
- **Não** é terminal para a fila RC3.7.5: `FilaRecuperacaoXml` inclui `XML_INDISPONIVEL` e o motor consulta `consChNFe` (até `maxTentativas` / `maxDiasMonitoramento`).
- Reabertura oficial RC3.4.8: → `RESUMO_RECEBIDO` (lote). Também é permitida → `XML_COMPLETO` se chegar procNFe.
- Cooldown 656 existente permanece; **não** foi criado scheduler novo nem retry infinito.

## Correção

Em `CentralManifestacaoDfeService`:

1. cStat 596 (ao vivo ou legado) chama `_resolverAposEvento596`.
2. `consChNFe` com o **mesmo** contexto/CNPJ/PFX/`empresaId` do documento.
3. Se houver procNFe persistido → **não** encerra; retorna XML completo.
4. Se `consChNFe` = **137** → `XML_INDISPONIVEL` com evidência de ausência na consulta por chave.
5. Erro de transporte, 656, 138 sem XML → **não** marca `XML_INDISPONIVEL`.
6. `consultarNotaPorChave` agora grava cStat/xMotivo no evento de consulta.

Não há workaround da NF 541588. Pipeline Oficial, MIIP, Motor Fiscal, estoque e financeiro não foram alterados.

## Testes

Executados:

- `node tests/central-entradas/central-xml-multicnpj-02.test.js` — **12 ok**
- `node tests/central-entradas/central-xml-multicnpj-01.test.js` — **11 ok**
- `node tests/central-entradas/rc747-cstat-596-terminal.test.js` — homologado
- `node tests/central-entradas/rc336-recuperacao-xml.test.js` — homologado
- `node tests/central-entradas/maquina-estados.test.js` — 11 ok (via `test:central-entradas`)

`npm run test:central-entradas` **não passou por completo**: sprint2 (listagem/`empresa_id`) falhou como já relatado na MULTICNPJ-01. Falhas **pré-existentes**, não introduzidas por este classificador.

Suíte completa do repositório (`npm test`) **não** foi executada.

Script: `npm run test:central-xml-multicnpj-02`.

## Teste funcional

**Não executado** contra a SEFAZ (ambiente de produção; risco de 656 / evento já 596).

Esperado no próximo ciclo operacional (motor de recuperação, sem nova ciência):

- documentos já `XML_INDISPONIVEL` continuam elegíveis à fila `consChNFe`;
- notas ainda `RESUMO_RECEBIDO`: ciência → se 596, `consChNFe` antes de encerrar.

Se a SEFAZ responder 137, `XML_INDISPONIVEL` passará a ter evidência real. Se responder 138+docZip, deve persistir `PROC_NFE`.

## Limitações

- SOAP completo de `consChNFe` da 541588 **não existe** no banco.
- `tpAmb` / `nProt` da ciência 596 não estão no JSON persistido (HTTP/cStat/xMotivo/endpoint sim).
- Documentos já encerrados em 17/09 **não** foram reprocessados aqui.
- Sprint2 da suíte Central continua vermelha (isolamento de listagem).

## Próximos passos

1. Deixar o motor RC3.7.5 consultar as filiais (já prioriza `XML_INDISPONIVEL`).
2. Auditar o **primeiro** evento `CONSULTA_DFE_POS_MANIFESTACAO` da NF 541588 (cStat 137 vs 138).
3. Só então chamar de “XML indisponível na SEFAZ” se o cStat da **consulta por chave** comprovar.

## Critério de aceite

| Item | Status |
|------|--------|
| causa identificada | sim — classificador 596 |
| retorno SEFAZ identificado | sim — RecepcaoEvento4 596; consChNFe **ausente** |
| cStat | 596 (ciência) |
| xMotivo | prazo 10 dias |
| ciência auditada | sim — rejeitada |
| consChNFe auditado | sim — **não chamado** no fato; agora obrigatório pós-596 |
| CNPJ / PFX | empresa 3 / PFX 3 (ciência) |
| docZip | ausente |
| persistência | resNFe; status derivado de 596 |
| regra XML_INDISPONIVEL | auditada e ajustada |
| retry | fila RC3.7.5; sem remanifestar |
| Filial 2 / 3 / Matriz | comparadas |
| testes | 02+01+rc747+rc336; suíte sprint2 pré-falha |
| relatório | este arquivo |
