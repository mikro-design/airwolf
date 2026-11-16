// SPDX-License-Identifier: BSD-2-Clause
#include "dissect_gps.hpp"
#include <iostream>
int main(int argc,char**argv){try{
  if(argc!=3)throw std::runtime_error("Usage: GPS_LNAV HEX PRN");
  std::string hex=argv[1];if(hex.size()!=80)throw std::runtime_error("Expected 40 bytes");
  std::vector<std::uint8_t> bytes;
  for(std::size_t at=0;at<hex.size();at+=2){std::size_t used=0;auto b=std::stoul(hex.substr(at,2),&used,16);if(used!=2)throw std::runtime_error("Invalid hex");bytes.push_back(static_cast<std::uint8_t>(b));}
  std::cout<<airwolf::gps::inspect(bytes,static_cast<unsigned>(std::stoul(argv[2])))<<'\n';return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
