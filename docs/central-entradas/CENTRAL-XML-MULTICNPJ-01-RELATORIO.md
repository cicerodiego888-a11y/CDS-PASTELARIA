# CENTRAL-XML-MULTICNPJ-01 — Relatório

## STATUS

**CONCLUÍDO COM RESSALVAS**

Causa raiz identificada e corrigida no código. Certificados/CNPJs das três empresas resolvem isolados. A descarga real do XML na SEFAZ para Filial 2 e Filial 3 **não foi executada neste sprint** (ambiente de produção; ciência + janela NT + DistDFe). Os documentos das filiais no banco **continuam** em `RESUMO_RECEBIDO` até o próximo ciclo operacional com o código novo.

Não foi inventado sucesso funcional ponta a ponta.

## Causa raiz

A sincronização DistDFe/NSU **já era por CNPJ** (`CentralSincronizacaoService._sincronizarEmpresa` + `central_entradas_nsu`). Por isso os resumos chegam nas três empresas.

A ciência (210210) e a recuperação `consChNFe` **não** usavam o `empresa_id` do documento. Chamavam `obterContextoOperacional()` sem `empresaId`, o que cai no `getFiscalConfig` global — na prática a **Matriz**.

Consequência:

- SOAP DistDFe/`consChNFe` com CNPJ/certificado da Matriz para chave da Filial → SEFAZ não devolve `procNFe`/`docZip` da filial.
- Persistência `buscarPorChave(chave, empresa_id)` (05.70): mesmo que viesse XML no contexto errado, **não atualizaria** o documento da filial (`empresaId` nulo → lookup retorna `null`).
- Ciência, se ocorresse, iria assinada com CNPJ da Matriz.

Etapa exata da falha: **depois da persistência do resumo**, em **ciência + recuperação XML** (não no DistDFe/NSU inicial). Classificação: **A (antes da chamada correta)** — a chamada existia, mas o contexto era o da Matriz; **C** no retorno (sem XML para o CNPJ errado).

## Evidências (banco operacional)

Consulta somente leitura em `mercadao.db` (CNPJs e chaves mascarados).

### Empresas

| id | Fantasia | CNPJ mascarado | Ativo |
|----|----------|----------------|-------|
| 1 | PASTELARIA DO CHEFF - Matriz | 38.\*\*\*.\***/0001-15 | 1 |
| 2 | PASTELARIA DO CHEFF - Filial 2 | 38.\*\*\*.\***/0003-87 | 1 |
| 3 | PASTELARIA DO CHEFF - Filial 3 | 38.\*\*\*.\***/0002-04 | 1 |

### Configuração fiscal (sem senhas)

| empresa_id | PFX | Ambiente | Origem do contexto (pós-correção, `permitirFallbackGlobal=false`) |
|------------|-----|----------|---------------------------------------------------------------------|
| 1 | `certificado-empresa-1.pfx` | 1 (produção) | `empresas_configuracao_fiscal` |
| 2 | `certificado-empresa-2.pfx` | 1 | `empresas_configuracao_fiscal` |
| 3 | `certificado-empresa-3.pfx` | 1 | `empresas_configuracao_fiscal` |

Os três PFX existem e o contexto **não** faz fallback global quando `empresaId` é informado.

Validade X.509 não foi impressa neste relatório (evita abrir PFX com senha no log). Achado: arquivos distintos por empresa; **não** se assume que o certificado da Matriz sirva às filiais.

### NSU (produção, ambiente 1)

| CNPJ mascarado | ultNSU | maxNSU | último cStat | sync |
|----------------|--------|--------|--------------|------|
| 38.\*\*\*.\***/0001-15 | 107 | 107 | 138 | 2026-09-16T23:50:12Z |
| 38.\*\*\*.\***/0003-87 (Filial 2) | 15 | 15 | 138 | 2026-09-16T23:50:12Z |
| 38.\*\*\*.\***/0002-04 (Filial 3) | 8 | 8 | 137 | 2026-09-16T23:50:13Z |

DistDFe por CNPJ está vivo. Filial 2 recebeu lote (138). Filial 3 estava na ponta do NSU (137 = nada novo).

### Documentos

| Papel | id | empresa_id | NF | status | tipo | xml_len | Observação |
|-------|-----|------------|----|--------|------|---------|------------|
| Matriz XML ok | 41 | 1 | 430 | EM_REVISAO | PROC_NFE | 8924 | XML persistido |
| Filial 2 (exemplo do sprint) | 106 | 2 | 4430 | RESUMO_RECEBIDO | RES_NFE | 542 | NOSSA MASSA, R$ 4.018 |
| Filial 3 | 33 | 3 | 4422 | RESUMO_RECEBIDO | RES_NFE | 542 | NOSSA MASSA |

Totais: Matriz 5× PROC_NFE + 60× RESUMO; Filial 2 **15 RESUMO / 0 XML**; Filial 3 **8 RESUMO / 0 XML**. Há 1 PROC_NFE legado com `empresa_id` NULL.

Eventos do doc **106**: `DOCUMENTO_RECEBIDO`, depois `RECUPERACAO_XML_ENTROU_FILA`. **Sem** `CIENCIA_ENVIADA`, **sem** `MANIFESTACAO_ACEITA`, **sem** `CONSULTA_DFE_POS_MANIFESTACAO`. A fila de recuperação entrou; a ciência da filial não foi registrada.

## Comparação Matriz × Filial 2 × Filial 3

| Campo | Matriz (ex. id 41) | Filial 2 (id 106) | Filial 3 (id 33) |
|-------|--------------------|-------------------|------------------|
| empresa_id | 1 | 2 | 3 |
| CNPJ destinatário (cadastro) | …0001-15 | …0003-87 | …0002-04 |
| CNPJ DistDFe/NSU | próprio (ok) | próprio (ok) | próprio (ok) |
| CNPJ ciência / consChNFe **antes** | global/Matriz | global/Matriz | global/Matriz |
| CNPJ ciência / consChNFe **depois** | empresa_id do documento | empresa_id do documento | empresa_id do documento |
| Certificado DistDFe | PFX empresa 1 | deveria ser PFX 2; era global | deveria ser PFX 3; era global |
| Ambiente | 1 | 1 | 1 |
| NSU do documento | 43 | 15 | 6 |
| Tipo persistido | PROC_NFE | RES_NFE | RES_NFE |
| XML completo | sim | não (só resumo) | não |
| Manifestação no histórico | n/d neste recorte | ausente | não auditado evento a evento |
| cStat/xMotivo ciência | — | não houve chamada registrada | — |
| docZip | implícito no PROC | ausente | ausente |

## Fluxo mapeado

SEFAZ → DistDFe (NSU por CNPJ+ambiente) → resNFe → persistência com `empresa_id` → **[quebra]** contexto global na ciência/consChNFe → sem procNFe da filial → Central permanece RESUMO_RECEBIDO / AGUARDANDO XML.

Pipeline Oficial, MIIP, Motor Fiscal, estoque e financeiro **não** foram alterados.

## Correção aplicada

Novo helper `resolverContextoDocumentoCentral.js`:

- deriva `empresaId` do documento;
- em MULTIEMPRESA, `permitirFallbackGlobal=false` (filial não vira Matriz);
- mascara CNPJ/chave nos logs.

`CentralManifestacaoDfeService` e `MotorRecuperacaoXmlService`:

- `obterContextoOperacional({ empresaId })` a partir do documento;
- `persistenciaService` com o mesmo `empresaId` em DistDFe e `consChNFe`;
- logs: `empresa_id`, CNPJ mascarado, chave mascarada, etapa, tentativa, cStat, xMotivo, HTTP se houver.

Não criou scheduler novo. Não duplicou Pipeline. Não mudou regra de ciência (210210 / cStat 135/573/596 intactos).

## Arquivos alterados

- `backend/motores/central-entradas/services/resolverContextoDocumentoCentral.js` (novo)
- `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js`
- `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js`
- `tests/central-entradas/central-xml-multicnpj-01.test.js` (novo)
- `package.json` (`test:central-xml-multicnpj-01`)
- este relatório

## Testes

`node tests/central-entradas/central-xml-multicnpj-01.test.js` → **11 ok**.

Cobertura: Matriz/Filial2/Filial3 no consChNFe; CNPJ e PFX corretos; persistência isolada; cStat 137; erro SEFAZ; retry no mesmo CNPJ; XML já persistido; Matriz recupera sem contaminar filial; ciência da Filial 2; regressão DistDFe/NSU no fonte da sync.

Regressão relacionada **OK**: `rc375-recuperacao-xml`, `rc336-recuperacao-xml`, `modo-multiempresa-05-54`, `identidade-documento-empresa-05-70`.

`npm run test:central-entradas`: máquina de estados 11/11; **sprint 2 falhou listagem/PATCH** (filtro `empresa_id` da Central em banco real — pré-existente, fora deste sprint). `rc33` cooldown DistDFe e `rc747` transição XML_INDISPONIVEL também falharam isolados; **não** tocam o helper de contexto XML.

Suíte completa do repositório (MBC, fiscal, etc.) **não** foi reexecutada na íntegra.

## Teste funcional SEFAZ

**Bloqueio:** não disparar ciência/`consChNFe` de produção a partir desta sessão (risco 656 / evento indevido).

Para validar na operação, após deploy/restart:

1. Confirmar política de manifestação (automática vs manual).
2. Sincronizar as três empresas.
3. Acompanhar doc 106 (Filial 2) e um RESUMO da Filial 3: eventos `CIENCIA_ENVIADA` / `MANIFESTACAO_ACEITA` com `empresa_id` e CNPJ mascarado da filial; depois DistDFe/consChNFe; `tipo_documento=PROC_NFE`.
4. Matriz: um PROC existente (ex. id 41) deve permanecer válido.

## Limitações / ressalvas

- Filiais ainda estão RESUMO no banco até o ciclo real.
- Matriz também tem dezenas de RESUMO (ciência/XML não é universal mesmo na Matriz).
- PFX das filiais: arquivos distintos; conteúdo/CNPJ do certificado A1 não foi decodificado aqui.
- CSC e senhas **não** constam deste relatório (apareceram em query interna e foram omitidos).

## Próximos passos (somente os necessários)

1. Reiniciar o ERP com este código e observar um ciclo de ciência+recuperação das filiais.
2. Sprint separado de período da Central (fora de escopo, conforme pedido).
