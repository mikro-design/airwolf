// SPDX-License-Identifier: AGPL-3.0-or-later
#include <srsran/phy/utils/convolution.h>
#include <complex.h>
#include <stdio.h>

int main(void)
{
  cf_t input[12], output[12];
  for(unsigned i=0;i<12;++i){input[i]=1+2*I;output[i]=9-3*I;}
  // Empty sums have defined zero outputs; null filter is never dereferenced.
  if(srsran_conv_same_cf(input,NULL,output,12,0)!=12)return 1;
  for(unsigned i=0;i<12;++i)if(output[i]!=0)return 2;
  // Empty input never dereferences a pointer or constructs a zero-length VLA.
  if(srsran_conv_same_cf(NULL,NULL,NULL,0,0)!=0)return 3;
  float filter[3]={.25f,.5f,.25f};
  if(srsran_conv_same_cf(NULL,filter,NULL,0,3)!=0)return 4;
  // Ordinary production smoothing remains normalized, including both edges.
  if(srsran_conv_same_cf(input,filter,output,12,3)!=12)return 5;
  for(unsigned i=0;i<12;++i)if(cabsf(output[i]-input[i])>1e-6f)return 6;
  puts("Empty convolution and ordinary smoothing pass");
  return 0;
}
