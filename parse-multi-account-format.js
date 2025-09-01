// 专门处理多账号连续格式的解析器扩展
class MultiAccountFormatParser {
  constructor() {
    this.emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    this.countryCodeRegex = /^[a-z]{2,3}$/i;
  }

  // 检测是否为多账号连续格式
  isMultiAccountFormat(text) {
    // 移除多余空格并分割
    const tokens = text.trim().split(/\s+/);
    
    // 计算邮箱数量
    const emailCount = tokens.filter(token => this.emailRegex.test(token)).length;
    
    // 如果有4个或更多邮箱，可能是多账号格式
    // 检查是否符合：邮箱-密码-邮箱-密码的模式
    if (emailCount >= 4) {
      // 找到所有邮箱的位置
      const emailPositions = [];
      tokens.forEach((token, index) => {
        if (this.emailRegex.test(token)) {
          emailPositions.push(index);
        }
      });
      
      // 检查邮箱是否成对出现（间隔应该是2）
      for (let i = 0; i < emailPositions.length - 1; i += 2) {
        if (i + 1 < emailPositions.length) {
          const gap = emailPositions[i + 1] - emailPositions[i];
          if (gap === 2) {
            return true; // 找到至少一对符合模式的邮箱
          }
        }
      }
    }
    
    return false;
  }

  // 解析多账号连续格式
  parseMultiAccountFormat(text) {
    const results = [];
    
    // 按行分割处理，以便正确处理每行末尾的国家代码
    const lines = text.trim().split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      
      // 检查最后一个token是否是国家代码
      let effectiveTokens = tokens;
      if (tokens.length >= 5) {
        const lastToken = tokens[tokens.length - 1];
        if (this.countryCodeRegex.test(lastToken) && !this.emailRegex.test(lastToken)) {
          // 移除末尾的国家代码
          effectiveTokens = tokens.slice(0, -1);
        }
      }
      
      // 处理单行数据
      if (effectiveTokens.length >= 3) {
        const mainEmail = effectiveTokens[0];
        const mainPassword = effectiveTokens[1];
        const auxEmail = effectiveTokens[2];
        let auxPassword = '';
        
        // 检查是否有辅助密码
        if (effectiveTokens.length >= 4) {
          // 如果第4个token是国家代码（长度为2-3的纯字母），则辅助密码为空
          if (this.countryCodeRegex.test(effectiveTokens[3]) && effectiveTokens.length === 4) {
            auxPassword = '';  // 国家代码不作为密码
          } else {
            auxPassword = effectiveTokens[3];
          }
        }
        
        // 验证邮箱格式
        if (this.emailRegex.test(mainEmail) && this.emailRegex.test(auxEmail)) {
          // 判断账号类型
          let accountType = 'Gmail';
          if (mainEmail.includes('outlook') || mainEmail.includes('hotmail')) {
            accountType = 'Outlook';
          } else if (mainEmail.includes('yahoo')) {
            accountType = 'Yahoo';
          }
          
          results.push({
            account_type: accountType,
            email: mainEmail,
            email_password: mainPassword,
            auxiliary_email: auxEmail,
            auxiliary_email_password: auxPassword,
            storage_date: '现在',
            account_key: ''
          });
        }
      }
    }
    
    // 如果按行处理没有结果，尝试原来的连续格式处理
    if (results.length === 0) {
      const tokens = text.trim().split(/\s+/);
      let i = 0;
      
      while (i < tokens.length) {
        // 检查是否有足够的元素组成一个账号
        if (i + 3 < tokens.length) {
          const mainEmail = tokens[i];
          const mainPassword = tokens[i + 1];
          const auxEmail = tokens[i + 2];
          const auxPassword = tokens[i + 3];
          
          // 验证邮箱格式
          if (this.emailRegex.test(mainEmail) && this.emailRegex.test(auxEmail)) {
            // 检查下一个token是否是国家代码（如果存在）
            let skipNext = false;
            if (i + 4 < tokens.length && this.countryCodeRegex.test(tokens[i + 4]) && !this.emailRegex.test(tokens[i + 4])) {
              skipNext = true;
            }
            
            // 判断账号类型
            let accountType = 'Gmail';
            if (mainEmail.includes('outlook') || mainEmail.includes('hotmail')) {
              accountType = 'Outlook';
            } else if (mainEmail.includes('yahoo')) {
              accountType = 'Yahoo';
            }
            
            results.push({
              account_type: accountType,
              email: mainEmail,
              email_password: mainPassword,
              auxiliary_email: auxEmail,
              auxiliary_email_password: auxPassword,
              storage_date: '现在',
              account_key: ''
            });
            
            i += skipNext ? 5 : 4;
          } else {
            i++;
          }
        } else {
          break;
        }
      }
    }
    
    return results;
  }

  // 生成解析报告
  generateParseReport(originalText, parsedResults) {
    let report = '📊 多账号格式解析报告\n';
    report += '━━━━━━━━━━━━━━━━━━━━━━\n\n';
    
    report += `📥 原始数据：\n${originalText}\n\n`;
    report += `✅ 成功解析：${parsedResults.length} 个账号\n\n`;
    
    parsedResults.forEach((account, index) => {
      report += `【账号 ${index + 1}】\n`;
      report += `├─ 类型：${account.account_type}\n`;
      report += `├─ 主邮箱：${account.email}\n`;
      report += `├─ 主密码：${account.email_password}\n`;
      report += `├─ 辅助邮箱：${account.auxiliary_email}\n`;
      report += `└─ 辅助密码：${account.auxiliary_email_password}\n\n`;
    });
    
    return report;
  }
}

// 测试示例
if (require.main === module) {
  const parser = new MultiAccountFormatParser();
  const testData = "LamartinaStuenkel@gmail.com  0y3vnme7n  amyneeckok@hotmail.com  rG75Sz08  ar SchwuchowDomiano@gmail.com  45svjjbov  lisdeyovejam@hotmail.com  PIKtBu45  si";
  
  console.log('测试多账号格式解析...\n');
  
  if (parser.isMultiAccountFormat(testData)) {
    console.log('✅ 检测到多账号格式\n');
    const results = parser.parseMultiAccountFormat(testData);
    console.log(parser.generateParseReport(testData, results));
  } else {
    console.log('❌ 不是多账号格式');
  }
}

module.exports = MultiAccountFormatParser;