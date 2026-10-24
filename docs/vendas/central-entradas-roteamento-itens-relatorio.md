# Sprint A — Auditoria e correção do roteamento de itens da Central

**Projeto:** CDS Sistemas — Pastelaria  
**Tipo:** integridade e rastreabilidade de itens de NF-e  
**Escopo:** parse XML → revisão/associação → Compra e persistência dos itens  
**Conclusão:** a classificação continua explícita por item; identidade original e decisão de roteamento passam a ser preservadas no item da compra.

## 1. Diagnóstico antes das alterações

O fluxo existente já exigia, para compras originadas na Central, um `tipo_operacional` por item (`COMERCIAL` ou `INSUMO`) e exatamente uma resolução: vínculo a `produto_id` ou solicitação explícita de criação. A compra também validava que o tipo escolhido correspondesse ao cadastro, sem reclassificar o produto.

Foram comprovadas estas lacunas:

1. `nfeXmlMapper` convertia `cProd` em `codigo_fornecedor` e escolhia `cEAN || cEANTrib` para um único campo de código de barras. O DTO não mantinha `nItem`, a distinção entre os dois GTINs nem o `<det>` original completo.
2. O bridge levava os itens parseados à tela de Compras, mas a normalização e a montagem do POST da tela reconstruíam cada item e descartavam campos não listados.
3. `compras_itens` persistia o produto e valores operacionais, mas não o `nItem`, snapshot da classificação escolhida, conteúdo original do item nem a proveniência da resolução. A chave da NF-e ficava no cabeçalho da Compra.
4. No MIP, `codigo_fornecedor`/`cProd` entrava na mesma lista de códigos genéricos usada para identificar produtos. Para XML da Central, o serviço tentava códigos sequencialmente e encerrava no primeiro produto encontrado; dois GTINs válidos que levassem a cadastros diferentes não eram tratados como ambiguidade.
5. O MIIP já tinha associação de fornecedor por CNPJ + `cProd` e decisão de revisão para candidatos semelhantes/sem gap suficiente. Esse comportamento foi preservado.

## 2. Arquivos alterados e correção aplicada

| Arquivo | Defeito concreto | Alteração |
|---|---|---|
| `backend/shared/nfe/mappers/nfeXmlMapper.js` | O mapeamento achatava os identificadores e descartava `nItem` e o `<det>` original. | Inclui `nfe_item_n`, `cProd`, `cEAN`, `cEANTrib` e o objeto original do item XML; não inventa `nItem` quando o XML não o fornece. |
| `backend/shared/nfe/contracts/NfeItemParseadoDTO.js` | O contrato serializado não expunha os campos de identidade original. | Preserva os novos campos e mantém os aliases legados (`codigo_fornecedor`, `codigo_barras`, `gtin`, `uCom`/`uTrib`). |
| `backend/motores/central-entradas/services/CentralComprasBridgeService.js` | Um parse antigo sem chave no payload poderia abrir uma Compra sem chave recebida do documento. | Preenche `chave_acesso` com a chave persistida do documento quando o parse não a contém. |
| `backend/motores/produto-identidade/services/EntradasProdutoIdentificacaoService.js` | `cProd` podia ser tratado como identidade global; múltiplos GTINs poderiam parar no primeiro vínculo. | No contexto `xml_central`, busca somente GTIN/EAN com formato e dígito verificador válidos, exclui `cProd` da busca genérica, avalia todos os GTINs e retorna ambiguidade quando identificam produtos distintos. Outros contextos conservam a estratégia anterior. |
| `backend/shared/nfe/enriquecerParseComMiip.js` | Ambiguidade detectada pelo MIP não elevava o documento para revisão; uma associação automática MIIP também podia prevalecer sobre GTINs MIP conflitantes. | Mantém o item sem `produto_id`, consolida candidatos e exige revisão quando MIIP e MIP apontam destinos diferentes; atualiza resultado/resumo do lote e sinaliza pendência para a Central. |
| `frontend/erp/js/compras.js` | A normalização, edição do item e payload do POST perdiam a origem XML e parte da decisão MIIP/MIP. | Preserva os campos ao normalizar, editar e enviar os itens da Compra. |
| `backend/database.js` | O esquema de `compras_itens` não tinha campos de rastreabilidade por item. | Adiciona, de forma segura e aditiva, `nfe_item_n`, `tipo_operacional`, `nfe_item_original_json` e `dados_roteamento_json`. Sem backfill destrutivo. |
| `backend/rotas/compras.js` | O item salvo não registrava a classificação e a resolução confirmadas da Central. | Persiste o tipo validado, o item XML original e a proveniência do vínculo/criação. Vínculo diferente da sugestão MIIP é registrado como explícito, não como correspondência automática. |
| `tests/shared/nfe/nfe-parser.test.js` | Não cobria os identificadores originais. | Verifica `nItem`, `cProd`, `cEAN`, `cEANTrib` e o `<det>` original nos dois itens da fixture. |
| `tests/produto-identidade/mip-sprint07-compras-xml-central.test.js` | Não cobria cProd genérico, GTINs conflitantes nem conflito entre associação automática MIIP e MIP. | Testa GTIN único, cProd sem escopo de fornecedor no MIP Central, GTINs que apontam a produtos diferentes, revogação de associação MIIP conflitante, atualização do resumo e criação de pendência. |
| `tests/miip/miip-importacao-xml.test.js` | Não tinha asserção de que descrições semelhantes com candidatos próximos não são autoassociadas. | Acrescenta teste em que a decisão MIIP exige confirmação entre dois candidatos próximos. |
| `tests/miip/motor-associacao-fornecedor.test.js` | Não cobria o mesmo `cProd` em fornecedores diferentes. | Testa resolução por CNPJ do fornecedor e ausência de vínculo cruzado. |
| `tests/compras/classificacao-itens-nfe-compra.test.js` | Não verificava a rastreabilidade persistida da compra mista nem a proveniência quando a seleção difere da sugestão. | Acrescenta asserções de chave, número de item, classificação, origem XML e decisão persistidas; testa também vínculo explícito contra sugestão diferente. |
| `tests/compras/rc4312-central-fluxos.test.js` | Não verificava a retenção dos campos ao atravessar a tela de Compras. | Acrescenta verificação da normalização e do payload do fluxo Central → Compras. |

**Workspace preexistente:** `backend/database.js`, `backend/rotas/compras.js` e `frontend/erp/js/compras.js` já tinham alterações locais antes desta sprint. As mudanças desta sprint foram integradas nos trechos relevantes; as demais alterações não foram revertidas. `tests/compras/classificacao-itens-nfe-compra.test.js` também já estava como arquivo não rastreado antes da sprint; seu conteúdo preexistente foi mantido e ampliado.

## 3. Contrato de identidade e roteamento

| Informação | Antes | Depois |
|---|---|---|
| Documento de origem | Chave no cabeçalho `compras`; documento Central vinculado à Compra. | Mantém a chave no cabeçalho e usa a chave persistida pelo documento como fallback no bridge. |
| Item original | O parse guardava campos normalizados; o número/objeto original podia se perder. | `nfe_item_n` e snapshot JSON do `<det>` original, incluindo `cProd`, `cEAN`, `cEANTrib`, descrição, unidades, quantidades, valores e grupos fiscais parseados. |
| Cadastro interno | `produto_id` existente na linha da Compra. | Mantido; continua sendo a resolução final do item. |
| Classificação | Exigida no payload e validada contra `produtos.tipo_operacional`. | Continua exigida por item e passa a ser gravada como snapshot em `compras_itens.tipo_operacional`. |
| Método/proveniência | MIIP/MIP/sugestão poderiam existir no parse, sem snapshot de compra. | `dados_roteamento_json` registra resolução, produto selecionado, método quando compatível com o produto final, resultados MIIP/MIP, sugestão e usuário que confirmou a Compra. |

`compras_itens.compra_id` relaciona a linha ao cabeçalho; `compras.chave_acesso` relaciona a Compra à NF-e. Para compras originadas na Central, a relação com o documento persistido continua sendo mantida pela ponte Central. O item XML original é preservado mesmo quando seus campos normalizados são usados por conversão/custo.

## 4. Estratégias de correspondência e ambiguidades

- **MIIP / código de fornecedor:** permanece associado ao par fornecedor (`CNPJ`) + `cProd`; o teste cobre o mesmo código em dois fornecedores e confirma resultados diferentes, sem lookup cruzado.
- **MIP / Central:** usa os GTINs/EANs válidos presentes no item. O validador aceita comprimentos GTIN-8/12/13/14 e confere o dígito verificador. `cProd` não é usado como código global nesse contexto.
- **Mais de um GTIN válido:** todos são avaliados. Se resultarem em IDs internos distintos, não há associação automática: o item fica sem `produto_id`, os candidatos são mantidos no resultado MIP e a Central recebe uma pendência de revisão.
- **Conflito entre MIIP e MIP:** se o MIIP associou automaticamente, mas os identificadores verificados pelo MIP apontam a outro produto ou a múltiplos produtos, a associação automática é revogada, os candidatos são combinados sem duplicar IDs e o resumo MIIP passa de automático para confirmação manual. A condição original de associação automática é capturada antes de atualizar o objeto compartilhado do resultado.
- **MIIP com candidatos próximos:** a decisão já existente `SUGERIR`/`precisaConfirmacao` é preservada; a integração não transforma a sugestão em associação automática.
- **Confirmação de Compra:** exige classificação válida e vínculo existente ou criação explícita. A classificação incompatível com o cadastro continua rejeitada; nenhum tipo de produto é alterado silenciosamente.
- **Item novo:** o tipo escolhido continua determinando a classificação do cadastro criado. A criação permanece explícita.

## 5. Nota mista, persistência e migração

Uma mesma Compra mantém cada item independentemente classificado. O teste de compra mista verifica uma linha `COMERCIAL` e outra `INSUMO`, com produtos, números de item XML e snapshots diferentes. Valores, unidades e conversão continuam sob os serviços existentes; esta sprint não alterou fórmula de custo, conversão MUC, crédito de estoque, tributação ou reserva.

A migração acrescenta quatro colunas nullable em `compras_itens` e não modifica estados nem reclassifica produtos. Linhas históricas não recebem backfill inventado: mantêm os dados atuais e ficam com os novos campos nulos. Documentos legados sem os campos novos continuam aceitos, mas não ganham retroativamente um `nItem` que não foi armazenado.

## 6. Resultados reais dos testes

| Comando | Resultado observado |
|---|---|
| `node tests/shared/nfe/nfe-parser.test.js` | **6 passaram, 0 falharam.** |
| `node tests/compras/classificacao-itens-nfe-compra.test.js` | **15 passaram, 0 falharam.** Executado em banco temporário; inclui compra mista e persistência do snapshot. |
| `node tests/produto-identidade/mip-sprint07-compras-xml-central.test.js` com `DB_DIR` temporário | **13 passaram, 0 falharam.** Inclui o caso MIIP automático em conflito com os GTINs MIP, sem vínculo final e com revisão exigida. |
| `node tests/miip/miip-importacao-xml.test.js` | **12 passaram, 0 falharam.** |
| `node tests/miip/decision-engine.test.js` | **69 passaram, 0 falharam.** |
| `node tests/miip/motor-associacao-fornecedor.test.js` | **17 passaram, 0 falharam.** |
| `node tests/compras/rc4312-central-fluxos.test.js` | **4 passaram, 1 falhou.** O teste preexistente `confirmarAssociacaoMiip não retorna silenciosamente` espera texto direto na função, enquanto a confirmação delega a notificação a `confirmarAssociacaoMiipComProduto`; a nova asserção de preservação dos campos passou. Não alterado por não ser defeito do roteamento desta sprint. |
| `node tests/central-entradas/central-entradas-03-xml.test.js` | **11 passaram, 6 falharam.** Falharam os cenários de cStat 137, cStat 656, rejeição SEFAZ, isolamento de três empresas, lock de consulta e documento antigo/recuperação. O teste usa transporte simulado; nenhum serviço real foi chamado. Os cenários exercitam serviços Central com alterações locais preexistentes que esta sprint não tocou, por isso não foram corrigidos aqui. |
| `node --check` nos arquivos JavaScript alterados | **Passou** para os arquivos verificados. |
| `git diff --check` | **Passou**; Git emitiu apenas aviso de normalização CRLF/LF já existente em `backend/server.js`, arquivo não alterado nesta sprint. |

Resultado agregado dos testes funcionais listados: **147 aprovações e 7 falhas**. As falhas estão discriminadas acima; não são declaradas como aprovadas.

## 7. Não executado, riscos residuais e limitações

- Não foi executado um fluxo end-to-end visual no navegador. A preservação da tela foi coberta por teste de código e pelo POST isolado da rota, não por validação visual.
- Não foi executada a suíte integral de Central, Compras, Produtos e Insumos. A suíte Central listada acima já apresentou falhas; as demais foram limitadas aos testes pertinentes e isolados.
- O teste de candidatos semelhantes verifica a resposta MIIP de revisão quando dois candidatos próximos são apresentados; não cria um catálogo real de duplicados para executar todo o pipeline de similaridade em banco.
- O snapshot guarda o objeto original do `<det>` parseado. Não foi feita uma auditoria fiscal de todos os campos possíveis de cada variante de imposto; a preservação exata de todo byte do XML continua no XML do documento Central.
- Para documentos já parseados antes da alteração, `nfe_item_original` e `nfe_item_n` podem estar ausentes. Não há backfill nem reprocessamento automático nesta sprint.
- A classificação de um item novo ainda depende da decisão explícita do operador; a aplicação não infere `COMERCIAL`/`INSUMO` por descrição, tamanho, embalagem ou unidade.
- O catálogo de produtos continua compartilhado conforme o modelo existente. Não foi criada propriedade de produto por empresa. `empresa_id` e os vínculos de documento/Compra permanecem validados pelos fluxos atuais; não foi adicionado fallback de associação por empresa.
- A não atomicidade entre o commit da Compra e a atualização final do documento Central, idempotência global, cancelamentos e devoluções não foram alterados, conforme limite desta sprint.

## 8. Proteções

Os testes que inicializaram banco usaram diretórios temporários ou bancos em memória. **O banco oficial `C:\ProgramData\MercantilFiscal\dados` não foi aberto, migrado ou alterado.** Não houve chamada real à SEFAZ, sincronização, manifestação ou operação fiscal real. Não foram executados commit, push, merge, reset ou rollback destrutivo.
